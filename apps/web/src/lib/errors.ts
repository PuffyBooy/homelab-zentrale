import { isApiError } from './api.js';
import { retryMinutes } from './format.js';

/** User-facing text for an API error, following "Stimme und Text". */
export function errorText(err: unknown): string {
  if (!isApiError(err)) return 'Unerwarteter Fehler. Seite neu laden und erneut versuchen.';
  // A fixed hint from the core (e.g. "Server-Passwort: mindestens 8 Zeichen") wins.
  if (err.hint) return err.hint;
  switch (err.error) {
    case 'rate_limited':
      return `Zu viele Versuche. Wieder möglich in ${retryMinutes(err.retryAfter)} Min.`;
    case 'invalid_credentials':
      return 'Anmeldung abgelehnt. Benutzer, Passwort oder Code stimmt nicht.';
    case 'invalid_input':
      return 'Eingabe ungültig. Felder prüfen.';
    case 'network':
      return 'Zentrale nicht erreichbar. Verbindung prüfen und erneut versuchen.';
    case 'unauthorized':
      return 'Sitzung abgelaufen. Bitte neu anmelden.';
    case 'forbidden':
    case 'bad_origin':
      return 'Anfrage abgelehnt.';
    case 'step_up_required':
      return 'Bestätigung mit Code nötig.';
    case 'setup_invalid':
      return 'Setup-Link ungültig oder abgelaufen. Den aktuellen Link findest du im Log des Core-Containers.';
    case 'setup_done':
      return 'Setup ist schon erledigt. Melde dich an.';
    case 'not_found':
      return 'Nicht gefunden.';
    case 'conflict':
      return 'Konflikt mit dem aktuellen Stand. Seite neu laden.';
    case 'agent_offline':
      return 'Agent offline. Die Aktion geht wieder, sobald sich der Server meldet.';
    case 'agent_error':
      return 'Agent hat die Aktion abgelehnt oder sie ist fehlgeschlagen. Log des Agents prüfen.';
    case 'agent_timeout':
      return 'Agent hat nicht rechtzeitig geantwortet. Status prüfen und erneut versuchen.';
    case 'busy':
      return 'Auf diesem Ziel läuft gerade ein Deploy. Warten, bis er fertig ist.';
    case 'ci_not_green':
      return 'CI ist nicht grün. Deploy abgelehnt.';
    case 'github_error':
      return 'GitHub nicht erreichbar oder Anfrage abgelehnt. Details unter Einstellungen → GitHub.';
    case 'ha_error':
      return 'Home Assistant nicht erreichbar oder hat abgelehnt. Details unter Einstellungen → Home Assistant.';
    case 'module_disabled':
      return 'Modul ausgeschaltet. Einschalten unter Einstellungen → Module.';
    case 'bad_response':
      return 'Antwort der Zentrale unerwartet. Versionen von Core und Web prüfen.';
    default:
      return 'Fehler in der Zentrale. Log des Core-Containers prüfen.';
  }
}
