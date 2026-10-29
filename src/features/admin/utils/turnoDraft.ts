export interface TurnoDraft {
  id: string;
  inicio: string;
  fin: string;
}

let turnoDraftSeq = 0;

export const createTurnoDraft = (inicio = '', fin = ''): TurnoDraft => {
  turnoDraftSeq += 1;
  return { id: `turno-${turnoDraftSeq}`, inicio, fin };
};
