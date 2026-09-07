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
