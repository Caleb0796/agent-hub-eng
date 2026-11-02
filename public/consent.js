const form = document.querySelector('form[action="/authorize"]');
const error = document.getElementById('consent-error');
let submitting = false;
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || !(event.submitter instanceof HTMLButtonElement)) return;
  submitting = true;
  error.hidden = true;
  const body = new URLSearchParams(new FormData(form));
  body.set('decision', event.submitter.value);
  const buttons = Array.from(form.querySelectorAll('button'));
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const response = await fetch('/authorize', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? 'Authorization could not be completed.');
    if (typeof result.redirectTo !== 'string')
      throw new Error('The authorization response is missing a callback URL.');
    const destination = new URL(result.redirectTo);
    if (
      destination.origin !== form.dataset.callbackOrigin ||
      destination.pathname !== form.dataset.callbackPath
    )
      throw new Error(
        'The authorization callback does not match the client you originally confirmed.',
      );
    // Navigation follows the native OAuth callback chain; form-action remains self.
    location.assign(destination.href);
  } catch (cause) {
    error.textContent =
      cause instanceof Error
        ? cause.message
        : 'The connection was not completed. Start the authorization again.';
    error.hidden = false;
    // No automatic retries: the transaction may already have been consumed.
    error.textContent +=
      " Do not submit this page again. Start the connection again from your Agent's native app.";
  }
});
