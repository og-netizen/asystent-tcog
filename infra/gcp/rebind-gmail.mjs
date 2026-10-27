// Private stdin/stdout helper. Never run this directly with real credentials.
import {gmailVault} from '../../gmail-oauth.mjs';
let raw='';
for await (const chunk of process.stdin) { raw+=chunk; if(raw.length>65536)process.exit(2); }
try {
 const {config,source,target}=JSON.parse(raw);
 const saved=gmailVault(config.OAUTH_CLIENT_SECRET,source).open('refresh-token',config.GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED);
 if(!saved || saved.clientId!==config.GOOGLE_GMAIL_CLIENT_ID || saved.email!==(config.GOOGLE_GMAIL_EXPECTED_EMAIL||'og@tcog.pl').toLowerCase() || !saved.refreshToken)throw Error();
 config.GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED=gmailVault(config.OAUTH_CLIENT_SECRET,target).seal('refresh-token',saved);
 config.PUBLIC_URL=target;
 process.stdout.write(JSON.stringify(config));
} catch { process.stderr.write('GMAIL_ENVELOPE_VALIDATION_FAILED\n'); process.exitCode=2; }
