class TheorumError extends Error {
  constructor(message = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TheorumError';
  }
}

const UPSTREAM_FAILED = 'upstream failed';
const PUBLIC_GENERIC = 'Something went wrong. Try again.';
const PUBLIC_UNAVAILABLE = 'The model is unavailable. Try again.';
const PUBLIC_CANARY = "That reply wasn't safe to show. Try again.";
const PUBLIC_ACTION = "That action isn't available.";
const PUBLIC_FILE_TYPE = "That file type isn't supported.";
const PUBLIC_FILE_SIZE = 'That file is too large.';
const PUBLIC_FILE_COUNT = 'Too many files for one message.';
const PUBLIC_IMAGE_SIZE = "That image size isn't supported.";

const EXACT: Record<string, string> = {
  [UPSTREAM_FAILED]: PUBLIC_UNAVAILABLE,
  'empty Gemini stream': PUBLIC_UNAVAILABLE,
  'canary leaked': PUBLIC_CANARY,
  'expected JSON object': 'Something was wrong with that request.',
  'user input cannot be placed in the system block': PUBLIC_GENERIC,
  'attachment data must be base64': PUBLIC_FILE_TYPE,
  'attachment is too large': PUBLIC_FILE_SIZE,
  'attachments exceed the per-turn budget': PUBLIC_FILE_SIZE,
  'askUser.kind must be confirm, choice, or text': "That question isn't valid.",
  'askUser.prompt is required': 'That question needs a prompt.',
  'handoff.to is required': "That action isn't available.",
  'generateMedia is not wired; enable it on the profile when a media backend exists': PUBLIC_ACTION,
};

function publicText(text: string): string {
  const exact = EXACT[text];
  if (exact) {
    return exact;
  }
  if (text.startsWith('Gemini HTTP')) {
    return PUBLIC_UNAVAILABLE;
  }
  if (text.includes('not gated') || text.includes('not allowed')) {
    return PUBLIC_ACTION;
  }
  if (text.includes('MIME') || text.includes('does not accept attachments') || text.includes('does not accept voice')) {
    return PUBLIC_FILE_TYPE;
  }
  if (text.startsWith('At most')) {
    return PUBLIC_FILE_COUNT;
  }
  if (
    (text.startsWith('Only ') && text.includes('file'))
    || text.startsWith('Each file must be')
    || text.startsWith('Those files together')
  ) {
    return text;
  }
  if (text.includes('attachment')) {
    return PUBLIC_FILE_SIZE;
  }
  if (text.includes('aspect or size')) {
    return PUBLIC_IMAGE_SIZE;
  }
  if (text.includes('Unknown model select') || text.includes('Grounding tools')) {
    return PUBLIC_ACTION;
  }
  if (text.includes('Handoff target')) {
    return PUBLIC_ACTION;
  }
  if (text.includes('must pin thinking') || text.includes('has no models')) {
    return PUBLIC_GENERIC;
  }
  return PUBLIC_GENERIC;
}

function publicError(err: unknown): string {
  if (typeof err === 'string') {
    return publicText(err);
  }
  if (err instanceof TheorumError) {
    return publicText(err.message);
  }
  return PUBLIC_UNAVAILABLE;
}

function errorMessage(err: unknown): string {
  return publicError(err);
}

export {
  errorMessage,
  PUBLIC_ACTION,
  PUBLIC_CANARY,
  PUBLIC_GENERIC,
  PUBLIC_UNAVAILABLE,
  publicError,
  TheorumError,
  UPSTREAM_FAILED,
};
