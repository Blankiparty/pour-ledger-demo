'use strict';

// DISPENSING: payment approved, device started pouring.
// UNKNOWN:    payment approved, device cannot say whether the cup was filled.
// POURED / FAILED: final, confirmed by the device or decided by an operator.
const POUR_STATES = ['DISPENSING', 'POURED', 'FAILED', 'UNKNOWN'];

const POUR_TRANSITIONS = {
  DISPENSING: ['POURED', 'FAILED', 'UNKNOWN'],
  // UNKNOWN only leaves on evidence: the device's later report or an operator.
  // There is deliberately no timer, sweeper or webhook that moves it.
  UNKNOWN: ['POURED', 'FAILED'],
  POURED: [],
  FAILED: [],
};

function canMovePour(from, to) {
  return (POUR_TRANSITIONS[from] || []).includes(to);
}

module.exports = { POUR_STATES, POUR_TRANSITIONS, canMovePour };
