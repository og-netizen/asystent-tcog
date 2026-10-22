# Asystent TCOG — wFirma, wersja pilotażowa 0.1.0

Serwer MCP do prywatnego odczytu danych jednej firmy. Przygotowany dla Render / Node.js 22.
Kod nie zawiera kluczy ani danych z faktur. Nie został jeszcze połączony z kontem wFirma ani przetestowany w ChatGPT na żywo.

## 1. Wgranie kodu

1. Rozpakuj ZIP na komputerze.
2. Otwórz prywatne repozytorium `og-netizen/asystent-tcog` na GitHubie.
3. Wybierz **Add file → Upload files**.
4. Wgraj pliki z wnętrza folderu (nie ZIP i nie cały nadrzędny folder):
   `server.mjs`, `package.json`, `package-lock.json`, `test.mjs`, `README.md`.
5. Zatwierdź przez **Commit changes**. Nowy README może zastąpić początkowy README.
6. Sprawdź, że `package.json` leży bezpośrednio na głównej liście plików repozytorium.

## 2. Ustawienia Render

| Pole | Wartość |
|---|---|
| Service type | Web Service |
| Name | asystent-tcog |
| Language | Node |
| Branch | main |
| Region | Frankfurt, jeśli dostępny |
| Root Directory | puste |
| Build Command | npm ci |
| Start Command | npm start |
| Compute | Free na test |
| Health Check Path | /health |

W **Environment Variables** dodaj poniższe wartości. Klucze wpisuj bezpośrednio w Render, bez cudzysłowów. Nie zapisuj ich na GitHubie i nie wysyłaj w rozmowie.

| Nazwa | Wartość |
|---|---|
| NODE_VERSION | 22 |
| WFIRMA_COMPANY_ID | 1785731 — ID widoczne na Twoim zrzucie wFirmy; sprawdź zgodność |
| WFIRMA_ACCESS_KEY | Access key z wFirmy |
| WFIRMA_SECRET_KEY | Secret key z wFirmy |
| WFIRMA_APP_KEY | AppKey otrzymany od wFirmy |
| ADMIN_PASSWORD | Nowe, losowe hasło integracji, minimum 32 znaki. Wygeneruj w menedżerze haseł i zachowaj. |
| OAUTH_CLIENT_SECRET | Inny losowy sekret, minimum 32 znaki. Wygeneruj w menedżerze haseł i zachowaj. |

Serwer wykorzystuje automatycznie `RENDER_EXTERNAL_URL`. Poza Render wymagane jest `PUBLIC_URL` ustawione na publiczny adres HTTPS serwera, bez ścieżki `/mcp`.

Dopiero po dodaniu kodu i zmiennych kliknij **Deploy web service**. Sprawdź, że plan to Free.
Po uruchomieniu otwórz adres usługi z końcówką `/health`. Wynik `running` potwierdza działanie serwera, ale NIE sprawdza kluczy wFirmy.

## 3. Dodanie do ChatGPT

1. W formularzu nowej wtyczki podaj nazwę **Asystent TCOG**.
2. URL: rzeczywisty adres Render z końcówką `/mcp`, np. `https://ADRES-USLUGI.onrender.com/mcp`. Nie kopiuj przykładowej nazwy.
3. Wybierz **OAuth**. W zaawansowanych ustawieniach użyj własnego, wcześniej zarejestrowanego klienta:
   - Client ID: `asystent-tcog`
   - Client Secret: wartość `OAUTH_CLIENT_SECRET` z Render
   - Scope, jeżeli formularz go wymaga: `wfirma:read`
4. Odczytaj dokładny **Redirect URI / Callback URL** wyświetlony przez ChatGPT. Ten adres nie jest sekretem.
5. Dodaj w Render zmienną `OAUTH_REDIRECT_URIS` z tym dokładnym adresem i zrestartuj/wdróż usługę. Nie stosuj wildcardów. Możliwe jest kilka dokładnych adresów rozdzielonych przecinkami.
6. Zakończ tworzenie połączenia. Gdy otworzy się strona **Połącz Asystenta TCOG**, wpisz `ADMIN_PASSWORD` (to nie jest hasło do wFirmy) i zatwierdź odczyt.
7. Jeśli interfejs nie pozwala podać własnego Client ID i Client Secret, pokaż zrzut bez sekretów — nie przełączaj na brak uwierzytelniania. Ta wersja korzysta ze statycznego klienta OAuth, nie obsługuje DCR ani CIMD.

Domyślna lista adresów zwrotnych w kodzie służy kompatybilności ze starszym interfejsem. Aktualny adres z Twojej wtyczki ma pierwszeństwo i należy ustawić go w `OAUTH_REDIRECT_URIS`.

## 4. Pierwszy test na żywo

W nowej rozmowie włącz wtyczkę i poproś:

> Odczytaj dane firmy w wFirmie i potwierdź jej nazwę oraz NIP. Nie zmieniaj danych.

Oczekiwany NIP: **5862350060**. Następnie:

> Pobierz jedną fakturę sprzedaży (limit 1) i pokaż jej numer oraz kwotę.

Status AUTH / ACCESS DENIED wymaga sprawdzenia kluczy i uprawnień. Samo `/health` nie oznacza poprawnego dostępu do wFirmy.

## Zakres i ograniczenia

- Trzy narzędzia MCP: dane firmy, lista z paginacją, szczegóły rekordu.
- Zasoby: faktury sprzedaży, wydatki, płatności i kontrahenci. Stałe ID firmy z konfiguracji; użytkownik narzędzia nie może go nadpisać.
- Wyłącznie `get` i `find`. Brak zapisów, księgowania, usuwania, wysyłania dokumentów, tworzenia przelewów i dostępu do mBanku.
- Listy nie filtrują automatycznie pozycji niezapłaconych; stan rozliczeń musi być sprawdzony w zwróconych danych. Wyniki są stronicowane, domyślnie 10 rekordów, maksymalnie 50 na stronę.
- OAuth authorization code + PKCE S256, statyczny klient, jednorazowe kody. Token ważny 12 godzin; później trzeba ponownie autoryzować połączenie. Brak refresh tokenów w wersji pilotażowej.
- Restart kasuje rozpoczęte, niedokończone logowania. Rozpocznij wtedy logowanie ponownie.
- Zmiana `OAUTH_CLIENT_SECRET` unieważnia wydane tokeny i wymaga aktualizacji sekretu we wtyczce. Aby odciąć dostęp natychmiast, można także wstrzymać usługę Render.
- Globalny limit 10 błędnych haseł na 15 minut; to rozwiązanie dla jednego właściciela i jednej instancji, nie usługa wieloużytkownikowa.
- Dane odczytywane są na żądanie. Brak archiwum faktur i bazy danych. Kod nie zapisuje kluczy ani odpowiedzi API do logów.
- Render Free usypia usługę. Podczas pierwszego połączenia mogą wystąpić opóźnienia lub timeout; otwórz `/health`, zaczekaj na uruchomienie i ponów łączenie.
- To pilotażowa implementacja MCP Streamable HTTP (odpowiedzi JSON, protokół 2025-03-26). Potwierdzenie zgodności z aktualnym interfejsem ChatGPT nastąpi w teście na żywo.

## Walidacja

`node --test test.mjs` sprawdza odmowę dostępu bez tokena, PKCE, CSRF, odrzucanie nieznanego callbacku, jednorazowość kodów, odrzucanie zmienionego tokena, listę narzędzi oraz blokowanie zapisu, podmiany ID firmy i błędnej paginacji.
Testy wykorzystują atrapę wFirmy; nie sprawdzają prawdziwych danych ani uprawnień Twojego konta.
Brak zależności npm. `package-lock.json` jest dołączony dla `npm ci`.

Źródła: https://doc.wfirma.pl/ ; https://developers.openai.com/plugins/build/auth ; https://modelcontextprotocol.io/specification/2025-03-26/basic/transports ; https://render.com/docs/web-services

## FireTMS — odczyt operacyjny

Ustaw w Render `FIRETMS_API_KEY`. Opcjonalny `FIRETMS_BASE_URL` musi mieć wartość `https://app.firetms.com/api`. Klucza nie zapisuj w repozytorium. Dodaj scope OAuth `firetms:read` do połączenia i autoryzuj je ponownie. Narzędzia `firetms_list` i `firetms_order` obsługują wyłącznie GET do pojazdów, naczep, zleceń i ładunków; jawna lista pól usuwa pola finansowe oraz pola nieznane. Listy są stronicowane od 1, maksymalnie 50 pozycji. Filtry są dokładnym dopasowaniem numeru rejestracyjnego lub referencji klienta; nie są pełnotekstowym wyszukiwaniem. Opisy i notatki dowolne nie są eksportowane, bo mogą zawierać informacje finansowe. Tworzenie i edycja nie są jeszcze udostępnione.

Po starcie serwer wykonuje jeden odczyt pojazdu i zapisuje wyłącznie status połączenia `FIRETMS_DIAGNOSTIC` (bez klucza i danych pojazdu). Ten test potwierdza dostęp do listy pojazdów, nie do wszystkich endpointów.

## FireTMS operational writes (0.5.0)

OAuth `firetms:read` is sufficient for the three `firetms_preview_*` tools. `firetms:read firetms:write` is required for the three execution tools. Existing read-only tokens remain read-only. Refresh the ChatGPT tool snapshot and authorize the additional scope; do not replace secrets or disable OAuth.

- `firetms_create_load`: POST `/loads?allowClientOrderNumberDuplicates=false`. Creates a client order without price/payment fields. Requires an existing client identifier and complete route. A missing price can leave a DRAFT depending on FireTMS configuration.
- `firetms_create_transport_order`: POST `/transport-order` with existing `truckId` and `loadIds`. Rejects absent trucks and loads already assigned according to the API list. FireTMS assigns default semitrailer/drivers and computes costs from the truck settings; verify the returned transport set and actual status. Does not send messages to the driver.
- `firetms_update_load`: validates and previews the complete operational PUT `/loads/{loadId}` body. **Execution is disabled by default.** The official API documents the update body including an optional `price`, but does not state whether omitting it preserves the existing value. There is no full load detail endpoint for safely retrieving/preserving that value. Do not enable `FIRETMS_OPERATIONAL_PUT_VERIFIED=true` until omission semantics and operational-field replacement have been confirmed by FireTMS or a disposable sandbox test. Existing transport-order vehicle reassignment is not exposed by the documented API.

Every operation first uses its separate `firetms_preview_create_load`, `firetms_preview_create_transport_order`, or `firetms_preview_update_load` tool and returns a short-lived `review_token`. Execute the same payload and token through `firetms_create_load`, `firetms_create_transport_order`, or `firetms_update_load`. Neither public tool accepts `apply`. Preview tools are annotated read-only and perform only vendor GET requests; their only local effect is a temporary preparation receipt. Execution tools remain annotated as writes and require `firetms:write`. The token is bound to the exact payload and consumed for one attempt. Repeated successful calls return the cached result; uncertain outcomes are never retried automatically. Tokens expire after 15 minutes and do not survive a service restart. They are not durable idempotency keys: after restart/timeout, inspect the FireTMS system before preparing a fresh operation. Client references are checked before creation and server-side duplicate permission is false. For clients with no reference, FireTMS does not guarantee duplicate detection; verify their route/trailer manually before a new attempt.

Write HTTP transport is restricted to the official vendor origin and the three documented endpoints, does not follow redirects, and does not retry. No deletion, invoice, payment, cost, or price parameters are accepted. Preview success is not proof of a successful API write. Non-2xx/timeout results after a write are marked uncertain, not automatically classified as a safe retry.

Source: current official Swagger `https://app.firetms.com/api/v2/api-docs`, checked 2026-10-21. Live mutations have not been tested against production; tests use fake upstreams.

### TCOG provisional amounts — explicit operational exception, 2026-10-21

When final amounts are not yet known, the user authorized fixed placeholders of **1 EUR revenue and 1 EUR carrier cost**. Client-load creation supplies `price.amount=1`, `price.currencyCode=EUR`; external carrier forwarding-order creation supplies `cost.fixedAmount=1`, `cost.currencyCode=EUR`. Both are labeled provisional in internal notes for the closing agent to replace after completion. Arbitrary financial inputs, invoicing and payments remain unavailable. This does not enable load PUT editing. Own-fleet transport orders still compute costs according to FireTMS because their creation endpoint has no cost override field.


## Separate preview and execution tools (0.8.0)

After deployment, refresh the existing ChatGPT app tool list/actions. Keep the same app, MCP URL, OAuth client and secrets. Existing read-only connections can prepare previews; execution still requires reauthorization with `firetms:read firetms:write` and the host permission for writes. Refreshing tools alone does not grant write access. Old cached calls with `apply` are rejected before vendor access. Do not mark execution tools read-only to suppress approval. This split fixes preview classification; it does not override the host approval policy.
