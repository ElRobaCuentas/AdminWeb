import { useEffect, useRef, useState } from 'react';
import { firebaseAuth } from '../../../shared/config/firebase';
import { Card, CardHeader } from '../../../shared/ui/Card';
import { Button } from '../../../shared/ui/Button';
import { Badge } from '../../../shared/ui/StatusBadge';
import { EmptyState, Spinner } from '../../../shared/ui/Feedback';
import { Icon } from '../../../shared/ui/Icon';
import { getPulso, PulsoQueryError } from '../services/pulso_service';
import type { Incident, PulsoData } from '../services/pulso_service';
import { checkAge, closeLabels, formatDuration, formatMoment, incidentLabels, monitorPresentation, observedTripDetails, stateLabels, tripLabels } from '../pulsoPresentation';
import '../pulso.css';

type View = { status: 'loading' } | { status: 'error'; error: PulsoQueryError } |
  { status: 'ready'; data: PulsoData; receivedAt: number; error?: PulsoQueryError };

function IncidentList({ incidents }: { incidents: Incident[] }) {
  return <ul className="pulso-incidents">
    {incidents.map(item => <li key={item.id} className="pulso-incident">
      <div className="pulso-incident-heading">
        <h4>{incidentLabels[item.kind]}</h4>
        <Badge tone={item.closedAt === null ? 'warning' : 'neutral'}>{item.closedAt === null ? 'Abierto' : 'Cerrado'}</Badge>
      </div>
      <dl className="pulso-details pulso-incident-details">
        <div><dt>Inicio</dt><dd>{formatMoment(item.openedAt)}</dd></div>
        <div><dt>Última observación</dt><dd>{formatMoment(item.updatedAt)}</dd></div>
        <div><dt>Cierre</dt><dd>{item.closedAt === null ? 'Sin cierre registrado' : formatMoment(item.closedAt)}</dd></div>
        {item.closedAt !== null ? <>
          <div><dt>Duración registrada</dt><dd>{formatDuration(item.durationMs!)}</dd></div>
          <div className="pulso-incident-result"><dt>Resultado</dt><dd>{closeLabels[item.closeReason!]}</dd></div>
        </> : null}
      </dl>
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
  const trip = view.status === 'ready' ? observedTripDetails(view.data, view.receivedAt, now, !!error) : null;
  const inactive = state?.classification === 'inactive-unconfirmed' || state?.classification === 'inactive-finalized';
  const uncertain = !!age?.old || !!error;
  const monitor = check && age ? monitorPresentation(check, age.old, !!error) : null;
  return <div className="pulso-screen">
    <div className="pulso-toolbar">
      <div><p className="pulso-bus">{data ? `Bus ${data.busId}` : 'Monitor de seguimiento'}</p>
        <p className="text-muted">Recorrido, revisiones e incidentes en un solo lugar.</p></div>
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
        <Card className={`pulso-panel pulso-panel--${uncertain ? 'warning' : stateLabels[state.classification].tone}`}><CardHeader title="Estado del recorrido" />
          <div className="card-body">
            <div className="pulso-status">
              <span className="pulso-status-icon"><Icon name={inactive ? 'bus' : stateLabels[state.classification].tone === 'success' && !uncertain ? 'checkCircle' : 'info'} size={24} /></span>
              <div><h3>{uncertain ? 'Último estado: ' : ''}{tripLabels[state.classification].label}</h3>
                <p>{uncertain ? 'Según la última revisión guardada; falta confirmar la situación actual.' : tripLabels[state.classification].description}</p></div>
            </div>
            <dl className="pulso-details">
              {state.monitoringActive && !inactive ? <>
                <div><dt>Inicio observado</dt><dd>{state.observedTripStartedAt == null ? 'Inicio no determinado' : trip?.start}</dd></div>
                {state.observedTripStartedAt != null ? <div><dt>Tiempo de recorrido</dt><dd>{trip?.elapsed}</dd></div> : null}
              </> : null}
              <div><dt>Última publicación del bus</dt><dd>{formatMoment(state.publicationTimestamp)}</dd></div>
              {inactive ? <div><dt>Detención</dt><dd>{state.classification === 'inactive-finalized' ? 'Con evidencia registrada' : 'Declarada'}
                {state.classification === 'inactive-unconfirmed' ? <span className="pulso-detail-note">Sin verificación independiente</span> : null}</dd></div> : null}
            </dl>
            {state.monitoringActive && !inactive ? <p className="pulso-footnote">{state.observedTripStartedAt == null
              ? 'No hay un inicio confiable para calcular la duración.'
              : 'Desde la primera observación activa de PULSO. Incluye interrupciones; no mide transmisión GPS continua.'}</p> : null}
            <details className="pulso-technical"><summary>Detalle del estado registrado</summary>
              <p>{stateLabels[state.classification].label}</p>
              <dl className="pulso-details">
                <div><dt>Declaración del recorrido</dt><dd>{state.declaredActive === null ? 'Desconocida' : state.declaredActive ? 'Activo' : 'Inactivo'}</dd></div>
                <div><dt>Vigilancia registrada</dt><dd>{state.monitoringActive ? 'Activa' : 'Inactiva'}</dd></div>
              </dl>
            </details>
          </div>
        </Card>
        <Card className={`pulso-panel pulso-panel--${monitor!.tone}`}><CardHeader title="Estado de PULSO" />
          <div className="card-body">
            <div className="pulso-status">
              <span className="pulso-status-icon"><Icon name={monitor!.tone === 'success' ? 'checkCircle' : 'alert'} size={24} /></span>
              <div><h3>{monitor!.label}</h3><p>PULSO revisa el seguimiento cada minuto y registra el resultado.</p></div>
            </div>
            <dl className="pulso-details">
              <div><dt>Última revisión</dt><dd>{formatMoment(check.evaluatedAt)}</dd></div>
              <div><dt>Hace cuánto</dt><dd>{formatDuration(age.ageMs)}</dd></div>
              <div><dt>Conexión con Firebase</dt><dd>{monitor!.connection}</dd></div>
            </dl>
            <p className="pulso-footnote">{uncertain ? 'Conexión observada en la última revisión guardada; no confirma el acceso actual. ' : ''}Horas de Lima. Esta pantalla se actualiza cada 60 segundos; Actualizar solo consulta los registros.</p>
          </div>
        </Card>
      </div>
      <Card className="pulso-incident-panel"><CardHeader title="Incidentes" description="Problemas abiertos y últimos registros del seguimiento."
        action={<Badge tone={data!.activeIncidents.length ? 'warning' : uncertain ? 'neutral' : 'success'}>{data!.activeIncidents.length} {data!.activeIncidents.length === 1 ? 'activo' : 'activos'}</Badge>} />
        <div className="card-body">
          <section aria-labelledby="pulso-active-title">
            <h3 id="pulso-active-title">{data!.activeIncidents.length ? 'Incidentes activos' : 'Sin incidentes activos'}</h3>
            <p className="pulso-footnote">{data!.activeIncidents.length ? 'Permanecían abiertos en la última revisión.' : 'No hay problemas abiertos en los registros consultados.'}</p>
            {data!.activeIncidents.length ? <IncidentList incidents={data!.activeIncidents} /> : null}
          </section>
          <section className="pulso-history" aria-labelledby="pulso-history-title">
            <h3 id="pulso-history-title">Historial reciente</h3>
            <p className="pulso-footnote">Últimos 20 incidentes, abiertos y cerrados, del más reciente al más antiguo.</p>
            {data!.recentIncidents.length ? <IncidentList incidents={data!.recentIncidents} /> :
              <p className="pulso-history-empty">Sin incidentes registrados. Las revisiones del bus sí están guardadas.</p>}
          </section>
        </div>
      </Card>
    </> : null}
  </div>;
}
