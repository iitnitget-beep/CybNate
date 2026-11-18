/* Request lifecycle, outcome classification and provider deadlines for the main agent. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentRuntime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATES = Object.freeze(['CREATED', 'VALIDATING', 'THINKING', 'PLANNING', 'WAITING_FOR_MODEL', 'SELECTING_TOOL', 'WAITING_FOR_APPROVAL', 'EXECUTING_TOOL', 'PROCESSING_RESULT', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED']);
  const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED']);
  const NEXT = {
    CREATED: ['VALIDATING', 'FAILED', 'CANCELLED'],
    VALIDATING: ['THINKING', 'FAILED', 'CANCELLED'],
    THINKING: ['PLANNING', 'WAITING_FOR_MODEL', 'SELECTING_TOOL', 'PROCESSING_RESULT', 'COMPLETED', 'FAILED', 'CANCELLED'],
    PLANNING: ['THINKING', 'WAITING_FOR_MODEL', 'SELECTING_TOOL', 'WAITING_FOR_APPROVAL', 'EXECUTING_TOOL', 'PROCESSING_RESULT', 'COMPLETED', 'FAILED', 'CANCELLED'],
    WAITING_FOR_MODEL: ['WAITING_FOR_MODEL', 'SELECTING_TOOL', 'PROCESSING_RESULT', 'THINKING', 'FAILED', 'CANCELLED'],
    SELECTING_TOOL: ['WAITING_FOR_APPROVAL', 'EXECUTING_TOOL', 'PROCESSING_RESULT', 'FAILED', 'CANCELLED'],
    WAITING_FOR_APPROVAL: ['EXECUTING_TOOL', 'PROCESSING_RESULT', 'FAILED', 'CANCELLED'],
    EXECUTING_TOOL: ['PROCESSING_RESULT', 'CANCELLED', 'FAILED'],
    PROCESSING_RESULT: ['THINKING', 'PLANNING', 'WAITING_FOR_MODEL', 'SELECTING_TOOL', 'WAITING_FOR_APPROVAL', 'EXECUTING_TOOL', 'COMPLETED', 'FAILED', 'CANCELLED'],
    COMPLETED: [], FAILED: [], CANCELLED: [],
  };

  function requestError(message, code) {
    const e = new Error(message); e.code = code || 'invalid_request'; return e;
  }
  function validateUserRequest(value, maxChars) {
    if (typeof value !== 'string') throw requestError('Request must be text.', 'invalid_request');
    const text = value.trim();
    if (!text) throw requestError('Write a request before sending.', 'empty_request');
    const max = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 40000;
    if (text.length > max) throw requestError('Request is too long (' + text.length + ' characters; limit ' + max + '). Shorten it or attach files.', 'request_too_large');
    return text;
  }
  function createRequest(id, sessionId, now) {
    const clock = now || Date.now;
    const request = {
      id: String(id || ('req-' + clock())), sessionId: String(sessionId || ''), state: 'CREATED', outcome: null,
      trace: [{ state: 'CREATED', at: clock() }], terminal: false,
      transition(next, detail) {
        if (!STATES.includes(next)) throw requestError('Unknown request state: ' + next, 'invalid_state');
        if (this.terminal || !NEXT[this.state].includes(next)) throw requestError('Illegal request transition: ' + this.state + ' → ' + next, 'illegal_transition');
        this.state = next; this.terminal = TERMINAL.has(next);
        this.trace.push({ state: next, at: clock(), detail: detail ? String(detail).slice(0, 160) : '' });
        return this;
      },
      finish(outcome) {
        if (this.terminal) return false;
        this.outcome = outcome || { kind: 'completed' };
        const next = this.outcome.kind === 'failed' ? 'FAILED' : this.outcome.kind === 'cancelled' ? 'CANCELLED'
          : this.outcome.kind === 'blocked' ? 'BLOCKED' : this.outcome.kind === 'partial' ? 'PARTIAL' : 'COMPLETED';
        this.state = next; this.terminal = true;
        this.trace.push({ state: next, at: clock(), detail: this.outcome.reason ? String(this.outcome.reason).slice(0, 160) : '' });
        return true;
      },
      cancel(reason) { return this.finish({ kind: 'cancelled', reason: reason || 'Stopped by the user' }); },
      isActive() { return !this.terminal; },
      isCurrent(activeId) { return this.id === activeId && !this.terminal; },
    };
    return request;
  }

  function classifyOutcome(input) {
    input = input || {};
    const reasons = [];
    if (input.cancelled) reasons.push('Request was cancelled.');
    if (input.blocked) reasons.push(String(input.blocked));
    if (input.failedTools && input.failedTools.length) reasons.push(input.failedTools.length + ' tool operation(s) failed.');
    if (input.changedFiles && input.changedFiles.length && input.proof !== true) reasons.push('File changes were not verified by a successful run or test.');
    if (input.proof === false) reasons.push('The last verification command failed.');
    return { kind: input.cancelled ? 'cancelled' : input.blocked ? 'blocked' : reasons.length ? 'partial' : 'completed', reasons };
  }

  function createDeadline(parentSignal, ms, timers) {
    const Controller = typeof AbortController === 'function' ? AbortController : null;
    if (!Controller) throw requestError('AbortController is not available in this runtime.', 'unsupported_runtime');
    const controller = new Controller(), set = (timers && timers.setTimeout) || setTimeout, clear = (timers && timers.clearTimeout) || clearTimeout;
    let timedOut = false, timer = set(() => { timedOut = true; controller.abort(); }, Math.max(1, ms || 90000));
    const onParent = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener('abort', onParent, { once: true });
    }
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      dispose() { clear(timer); timer = null; if (parentSignal) parentSignal.removeEventListener('abort', onParent); },
    };
  }

  return { STATES, TERMINAL, validateUserRequest, createRequest, classifyOutcome, createDeadline };
});
