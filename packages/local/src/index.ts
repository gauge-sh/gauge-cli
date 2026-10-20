export {
  startSession, getSessionStatus, sendPrompt, answerQuestion,
  finishSession, stopSession, readSessionEventsNdjson, SessionNotFoundError, SessionUnavailableError, type StartSessionOptions,
} from "./session.js";
export { CredentialError, resolveSessionCredential } from "./credentials.js";
export type { CredentialSources } from "./credentials.js";
export type {
  AgentKind, AuthMode, ResourceRef, SessionSpec, SessionStatus,
  SessionEvent, Question, CommandReceipt,
} from "./types.js";
