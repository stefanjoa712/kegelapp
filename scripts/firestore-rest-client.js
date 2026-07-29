/**
 * Minimaler Firestore-REST-Client für das Migrations-Script.
 *
 * Warum kein firebase-admin: Das SDK verlangt ein "richtiges" Credential-Objekt
 * (Service-Account-Key oder Application Default Credentials über gcloud) und
 * akzeptiert kein selbstgebautes Token-Objekt - das führt zu
 * 'firestore/invalid-credential'. Die Firestore-REST-API selbst braucht dagegen
 * nur einen normalen "Authorization: Bearer <token>"-Header, genau das, was wir
 * über das Firebase-CLI-Login sowieso schon holen. Für die paar Operationen, die
 * dieses Script braucht (Dokument lesen/schreiben, Batch-Write), reicht das aus.
 *
 * Firestore-REST-Werte kommen in einem "Fields"-Wrapper-Format
 * (https://firebase.google.com/docs/firestore/reference/rest/v1/Value). Da die
 * App ihre Dokumente durchgehend als { value: "<JSON-String>" } speichert (ein
 * einzelnes String-Feld), reicht hier ein sehr kleiner Ausschnitt dieses Formats.
 */

const https = require('https');

function firestoreValueToJs(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.mapValue !== undefined) {
    const obj = {};
    const fields = value.mapValue.fields || {};
    for (const key of Object.keys(fields)) obj[key] = firestoreValueToJs(fields[key]);
    return obj;
  }
  return null;
}

function jsToFirestoreFields(obj) {
  const fields = {};
  for (const key of Object.keys(obj)) {
    fields[key] = { stringValue: String(obj[key]) };
  }
  return fields;
}

// Encoded jedes Pfad-Segment einzeln (die '/'-Trenner selbst bleiben unangetastet). Nötig, weil
// Dokument-IDs z.B. bei Gast-Namen Leerzeichen oder andere Sonderzeichen enthalten können ("guest-
// Max Mustermann") - ein unescapter Pfad lässt Node's http-Client mit
// 'ERR_UNESCAPED_CHARACTERS' abbrechen, da Leerzeichen in URLs nicht erlaubt sind.
function encodePathSegments(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function request(method, path, accessToken, body) {
  const bodyStr = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'firestore.googleapis.com',
        path,
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (e) {
            reject(new Error(`Antwort konnte nicht als JSON gelesen werden: ${data}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else if (res.statusCode === 404) {
            resolve(null);
          } else {
            reject(new Error(`Firestore-REST-Fehler (HTTP ${res.statusCode}): ${JSON.stringify(parsed)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

class FirestoreRestClient {
  constructor(projectId, accessToken) {
    this.base = `/v1/projects/${projectId}/databases/(default)/documents`;
    this.accessToken = accessToken;
  }

  // Liest ein Dokument. Gibt null zurück, wenn es nicht existiert.
  async getDoc(docPath) {
    const result = await request('GET', `${this.base}/${encodePathSegments(docPath)}`, this.accessToken);
    if (!result || !result.fields) return null;
    const obj = {};
    for (const key of Object.keys(result.fields)) obj[key] = firestoreValueToJs(result.fields[key]);
    return obj;
  }

  // Schreibt ein Dokument (überschreibt komplett, wie setDoc ohne merge).
  async setDoc(docPath, data) {
    await request('PATCH', `${this.base}/${encodePathSegments(docPath)}`, this.accessToken, {
      fields: jsToFirestoreFields(data)
    });
  }

  // Schreibt ein Dokument nur in den übergebenen Feldern (wie setDoc mit merge:true).
  async setDocMerge(docPath, data) {
    const fieldPaths = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    await request('PATCH', `${this.base}/${encodePathSegments(docPath)}?${fieldPaths}`, this.accessToken, {
      fields: jsToFirestoreFields(data)
    });
  }

  // Listet alle Dokumente einer Collection (folgt Pagination automatisch). Gibt eine Liste von
  // { id, ...felder } zurück. collectionPath ist relativ zur Datenbank-Wurzel, z.B. 'kegelbuch'.
  async listDocuments(collectionPath) {
    const results = [];
    let pageToken;
    do {
      const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
      const result = await request('GET', `${this.base}/${encodePathSegments(collectionPath)}${query}`, this.accessToken);
      if (!result) break;
      (result.documents || []).forEach((docData) => {
        const id = docData.name.split('/').pop();
        const obj = { id };
        for (const key of Object.keys(docData.fields || {})) obj[key] = firestoreValueToJs(docData.fields[key]);
        results.push(obj);
      });
      pageToken = result.nextPageToken;
    } while (pageToken);
    return results;
  }
}

module.exports = { FirestoreRestClient };
