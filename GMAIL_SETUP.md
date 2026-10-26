# Gmail OAuth setup — TCOG

This release prepares Google account authorization only. It does not start a
mail watcher, an AI classifier, label changes, filters, or outbound email.

## Google configuration

Enable Gmail API in the Google project. Create a Web application OAuth client.
For the existing Render service, register exactly:

`https://asystent-tcog.onrender.com/google/oauth/callback`

JavaScript origins are not needed by this server-side flow. Use an Internal
audience if available for the organization's own Workspace application. The user
grants `gmail.modify` and `gmail.settings.basic` in Google's consent screen.
The registered client and the OAuth consent configuration must allow both scopes.
No domain-wide delegation or account passwords are required.

## Render configuration

On the existing `asystent-tcog` service, add:

- `GOOGLE_GMAIL_CLIENT_ID`: the Google OAuth client ID.
- `GOOGLE_GMAIL_CLIENT_SECRET`: the Google client secret; never commit or paste in chat.
- `GOOGLE_GMAIL_EXPECTED_EMAIL`: `og@tcog.pl` (also the default).

Keep all existing environment variables. Save and deploy the new configuration.
Then open `https://asystent-tcog.onrender.com/google/oauth/start`, authenticate with
the existing TCOG `ADMIN_PASSWORD` (not Google's password), and choose Connect.
The server pins the mailbox after Google's consent and validates granted scopes.

## Persist authorization on Render Free

Render Free's local storage and process memory are ephemeral. The callback does
not pretend a durable connection has already been saved. It displays only an
AES-256-GCM encrypted envelope containing the refresh token, bound to the origin,
client and mailbox. The administrator copies that value directly into Render:

`GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED`

Save and deploy; return to the connection page and use Check saved connection.
This refreshes the token and verifies the Gmail profile, without reading mail or
changing filters. Do not send the encrypted envelope in chat either. Keep the
callback page until persistence is complete.

The envelope encryption derives from the existing server `OAUTH_CLIENT_SECRET`
with purpose separation. Do not change that secret without migrating/reconnecting
Gmail and considering the existing ChatGPT OAuth connection. The Google client
secret is a separate variable and must never replace it. Before enabling a
production worker, move token management to the chosen durable secret store and
persist job/history cursors separately.

## Protection and verification

- Admin password, bootstrap CSRF, exact Origin on POST and browser-bound encrypted
  authorization cookies; short-lived state and PKCE S256; Google offline consent.
- Fixed token/profile endpoints, no redirect-following and request timeouts.
- Wrong mailbox, missing scopes, missing offline token and invalid state fail closed.
- No raw Google tokens, client secrets or error bodies in logs/pages; no credentials
  in the repository. Only encrypted envelope exported to the authorized browser.
- Existing FireTMS/PTV/DBK and ChatGPT OAuth routes remain independent.
- Unit/integration tests mock Google. A real grant and post-redeploy refresh must
  still be performed by the account owner after credentials are configured.

## Next stage

Implement reviewable filter previews and idempotent creation of approved native
Gmail filters, then the persistent inbound queue and Niinivirta classifier.
The current private instruction plugin contains client rules; they have not been
automatically deployed as Gmail filters by this release.
