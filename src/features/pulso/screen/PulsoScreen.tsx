import { useEffect, useRef, useState } from 'react';
import { firebaseAuth } from '../../../shared/config/firebase';
import { Card, CardHeader } from '../../../shared/ui/Card';
import { Button } from '../../../shared/ui/Button';
import { Badge } from '../../../shared/ui/StatusBadge';
import { EmptyState, Spinner } from '../../../shared/ui/Feedback';
import { Icon } from '../../../shared/ui/Icon';
import { getPulso, PulsoQueryError } from '../services/pulso_service';
import type { Incident, PulsoData } from '../services/pulso_service';
import { checkAge, closeLabels, formatDuration, formatMoment, incidentLabels, stateLabels } from '../pulsoPresentation';
import '../pulso.css';

type View = { status: 'loading' } | { status: 'error'; error: PulsoQueryError } |
  { status: 'ready'; data: PulsoData; receivedAt: number; error?: PulsoQueryError };

function IncidentList({ incidents }: { incidents: Incident[] }) {
  return <ul className="registry">
    {incidents.map(item => <li key={item.id} className="row-card">
      <div className="row-info">
        <div className="row-title">{incidentLabels[item.kind]}</div>
        <div className="row-sub">Inicio: {formatMoment(item.openedAt)}</div>
        <div className="row-sub">Última observación: {formatMoment(item.updatedAt)}</div>
        {item.closedAt !== null ? <>
          <div className="row-sub">Cierre: {formatMoment(item.closedAt)} · Duración: {formatDuration(item.durationMs!)}</div>
          <div className="row-sub">Resultado: {closeLabels[item.closeReason!]}</div>
        </> : <div className="row-sub">Sin cierre registrado</div>}
      </div>
      <Badge tone={item.closedAt === null ? 'warning' : 'neutral'}>{item.closedAt === null ? 'Abierto' : 'Cerrado'}</Badge>
    </li>)}
  </ul>;
}

export function PulsoScreen() {
  const [view, setView] = useState<View>({ status: 'loading' });
  const refresh = useRef<() => void>(() => {});
  const [refreshing, setRefreshing] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      setRefreshing(true);
      void getPulso(() => firebaseAuth.currentUser?.getIdToken() ?? Promise.resolve(null), controller.signal)
        .then(data => {
          if (!controller.signal.aborted) {
            const receivedAt = Date.now();
            setNow(receivedAt);
            setView({ status: 'ready', data, receivedAt });
          }
        }).catch((error: PulsoQueryError) => {
          if (!controller.signal.aborted) {
            // Conservar el último resultado y su reloj, pero no datos tras una denegación.
            setView(previous => previous.status === 'ready' && !error.denied
              ? { ...previous, error } : { status: 'error', error });
          }
        }).finally(() => {
          inFlight = false;
          if (!controller.signal.aborted) setRefreshing(false);
        });
    };
    refresh.current = load;
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const data = view.status === 'ready' ? view.data : null;
  const state = data?.observedState;
  const check = data?.lastCheck;
  const age = check && view.status === 'ready' ? checkAge(check, view.receivedAt, now) : null;
  const error = view.status === 'loading' ? null : view.error;
  return <div className="pulso-screen">
    <div className="pulso-toolbar">
      <p className="text-muted">Estado e incidentes registrados por PULSO. Actualizar solo consulta los registros; no ejecuta una evaluación.</p>
      <Button type="button" variant="secondary" disabled={refreshing}
        onClick={() => refresh.current()} icon={<Icon name="clock" size={16} />}>
        {refreshing ? 'Consultando…' : 'Actualizar'}
      </Button>
    </div>
    <div aria-live="polite" aria-busy={refreshing}>
      {view.status === 'loading' ? <div className="pulso-loading"><Spinner /><p>Cargando PULSO…</p></div> : null}
      {error ? <div role="alert"><EmptyState
        icon={<Icon name={error.denied ? 'shieldOff' : 'alert'} />}
        title={error.denied ? 'Acceso denegado' : 'Error de consulta'} hint={error.message} />
        {data ? <p className="pulso-notice">Se muestran los últimos registros consultados; no se pudo confirmar si hay comprobaciones nuevas.</p> : null}
      </div> : null}
      {data?.status === 'no-data' ? <Card><EmptyState title="Sin registros de PULSO"
        hint={`Todavía no hay comprobaciones guardadas para el bus ${data.busId}. Actualizar no genera comprobaciones.`} /></Card> : null}
    </div>
    {state && check && age ? <>
      {age.old ? <p className="pulso-notice" role="status">Datos antiguos: la última comprobación tiene {formatDuration(age.ageMs)}.
        {' '}El estado y los incidentes son los observados en ese momento; no confirman la situación actual del bus.</p> : null}
      <div className="pulso-summary">
        <Card><CardHeader title={`Seguimiento del bus ${data!.busId}`} />
          <div className="card-body">
            <Badge tone={stateLabels[state.classification].tone}>{stateLabels[state.classification].label}</Badge>
            <dl className="pulso-details">
              <dt>Declaración del recorrido</dt><dd>{state.declaredActive === null ? 'Desconocida' : state.declaredActive ? 'Activo' : 'Inactivo'}</dd>
              <dt>Vigilancia registrada</dt><dd>{state.monitoringActive ? 'Activa' : 'Inactiva'}</dd>
              <dt>Última publicación observada</dt><dd>{formatMoment(state.publicationTimestamp)}</dd>
            </dl>
          </div>
        </Card>
        <Card><CardHeader title="Última comprobación de PULSO" />
          <div className="card-body"><Badge tone={age.old || error ? 'warning' : 'info'}>{age.old ? 'Datos antiguos' : error ? 'Última comprobación guardada' : 'Comprobación reciente'}</Badge>
            <dl className="pulso-details">
              <dt>Fecha y hora (Lima)</dt><dd>{formatMoment(check.evaluatedAt)}</dd>
              <dt>Antigüedad</dt><dd>{formatDuration(age.ageMs)}</dd>
              <dt>Fuente en esa comprobación</dt><dd>{{ ok: 'Accesible', missing: 'Sin nodo de tracking', unavailable: 'Inaccesible' }[check.sourceStatus]}</dd>
            </dl>
          </div>
        </Card>
      </div>
      <Card><CardHeader title="Incidentes activos" description="Incidentes que permanecían abiertos en la última comprobación." />
        {data!.activeIncidents.length ? <IncidentList incidents={data!.activeIncidents} /> :
          <EmptyState title="Sin incidentes activos" hint="No hay incidentes abiertos en los registros consultados." />}
      </Card>
      <Card><CardHeader title="Últimos 20 incidentes" description="Abiertos y cerrados, ordenados por fecha de apertura más reciente." />
        {data!.recentIncidents.length ? <IncidentList incidents={data!.recentIncidents} /> :
          <EmptyState title="Sin incidentes registrados" hint="Hay comprobaciones guardadas, pero todavía no hay incidentes." />}
      </Card>
    </> : null}
  </div>;
}
