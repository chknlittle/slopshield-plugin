export function executeInterpreter(document, interpreter) {
  const script = document.createElement("script");
  script.type = "text/javascript";

  const pageNonce = document.querySelector("script[nonce]")?.nonce;
  if (pageNonce) script.nonce = pageNonce;

  // Keep TrustedScript values intact. Coercing one through Function() turns it
  // back into a string, which YouTube rejects under Trusted Types enforcement.
  script.text = interpreter;

  const parent = document.head ?? document.documentElement;
  if (!parent) throw new Error("Cannot execute BotGuard before the document root exists");

  try {
    parent.appendChild(script);
  } finally {
    script.remove();
  }
}
