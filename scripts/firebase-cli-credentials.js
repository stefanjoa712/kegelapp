/**
 * Holt ein Google-Access-Token über das bereits vorhandene `firebase login`.
 *
 * Warum: Firebase CLI speichert nach `firebase login` ein Refresh-Token lokal
 * (unter ~/.config/configstore/firebase-tools.json bzw. das Windows-Äquivalent
 * unter %APPDATA%\configstore\firebase-tools.json). Wer schon `firebase deploy`
 * nutzt, hat das längst eingerichtet - ein zusätzliches `gcloud auth
 * application-default login` (separates Google-Cloud-SDK) ist dafür nicht nötig.
 *
 * Dieses Modul tauscht das gespeicherte Refresh-Token gegen ein kurzlebiges
 * Access-Token ein, über den öffentlichen, von Firebase selbst verwendeten
 * OAuth-Client (dieselbe Client-ID, die die Firebase-CLI intern nutzt - keine
 * eigenen Secrets nötig).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// Öffentliche OAuth-Client-Daten der Firebase-CLI selbst (nicht geheim, seit Jahren
// fixer, öffentlich bekannter Bestandteil von firebase-tools - kein eigenes Secret).
const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

function findConfigstorePath() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.config', 'configstore', 'firebase-tools.json'),
    // Windows legt Konfigurationsdateien mancher CLIs unter APPDATA statt HOME ab.
    process.env.APPDATA ? path.join(process.env.APPDATA, 'configstore', 'firebase-tools.json') : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readRefreshToken() {
  const configPath = findConfigstorePath();
  if (!configPath) {
    throw new Error(
      'Konnte die Firebase-CLI-Login-Datei nicht finden. Bitte einmal `firebase login` ausführen ' +
      '(falls ihr schon deployt, sollte das bereits passiert sein).'
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const token = raw.tokens && raw.tokens.refresh_token;
  if (!token) {
    throw new Error(
      `Gefunden: ${configPath}, aber kein refresh_token darin. Bitte erneut \`firebase login\` ausführen.`
    );
  }
  return token;
}

function exchangeRefreshToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Token-Austausch fehlgeschlagen (HTTP ${res.statusCode}): ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.access_token);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getFirebaseCliAccessToken() {
  const refreshToken = readRefreshToken();
  return exchangeRefreshToken(refreshToken);
}

module.exports = { getFirebaseCliAccessToken };
