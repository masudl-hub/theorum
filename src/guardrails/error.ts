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
  'This profile does not accept text input': PUBLIC_ACTION,
};

interface ErrorRule {
  match: (text: string) => boolean;
  resolve: (text: string) => string;
}

const RULES: ErrorRule[] = [
  {
    match: (t) => /^(Gemini|OpenRouter|TTS|OpenRouter TTS) HTTP/.test(t) || t.includes('TTS HTTP'),
    resolve: () => PUBLIC_UNAVAILABLE,
  },
  {
    match: (t) =>
      t.includes('not gated') ||
      t.includes('not allowed') ||
      t.includes('Unknown model select') ||
      t.includes('Grounding tools') ||
      t.includes('Handoff target'),
    resolve: () => PUBLIC_ACTION,
  },
  {
    match: (t) =>
      t.includes('MIME') ||
      t.includes('does not accept attachments') ||
      t.includes('does not accept voice'),
    resolve: () => PUBLIC_FILE_TYPE,
  },
  {
    match: (t) => t.startsWith('At most'),
    resolve: () => PUBLIC_FILE_COUNT,
  },
  {
    match: (t) =>
      (t.startsWith('Only ') && t.includes('file')) ||
      t.startsWith('Each file must be') ||
      t.startsWith('Those files together'),
    resolve: (t) => t,
  },
  {
    match: (t) => t.includes('attachment'),
    resolve: () => PUBLIC_FILE_SIZE,
  },
  {
    match: (t) => t.includes('aspect or size'),
    resolve: () => PUBLIC_IMAGE_SIZE,
  },
  {
    match: (t) => t.includes('must pin thinking') || t.includes('has no models'),
    resolve: () => PUBLIC_GENERIC,
  },
];

function publicText(text: string): string {
  const exact = EXACT[text];
  if (exact) {
    return exact;
  }
  for (const rule of RULES) {
    if (rule.match(text)) {
      return rule.resolve(text);
    }
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
