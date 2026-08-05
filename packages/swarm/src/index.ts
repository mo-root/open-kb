/**
 * The swarm's tools layer: what a lead and its investigators may DO, as data
 * in and data out. No provider call happens here that did not arrive through a
 * port, and no tool ever throws at a model — a failure is a sentence a reader
 * can act on, carried in the return value.
 *
 * Layered on the kernel (@open-kb/core): the evidence store proves quotes, the
 * ledger prices work, the board holds the questions, the breaker remembers
 * what failed. This package is env-free like core — credentials arrive through
 * ports, never through process.env.
 */

export {}
