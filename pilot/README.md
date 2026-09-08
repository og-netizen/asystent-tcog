# TCOG Pilot — jedno auto, bez wywołań AI

## Aktualny test na darmowym Renderze

`npm start` uruchamia teraz `pilot/free-start.mjs`: panel i dotychczasowe trasy MCP/OAuth na tym samym serwerze. Panel używa istniejącego `ADMIN_PASSWORD`. Nie wpisuj kluczy DBK w formularzu. Żadne dodatkowe zmienne ani płatne zasoby nie są wymagane.

To jawny tryb tymczasowy: każde uruchomienie tworzy nowy pusty katalog, bez odzyskiwania zleceń z poprzedniego procesu. Nie ma automatycznego pobierania ani diagnostyki startowej DBK. Po zapisaniu zlecenia przycisk pobiera jeden odcinek do godziny historii. Przed zakończeniem testu pobierz kopię JSON na komputer. Uśpienie lub restart kasuje dane testu; nie kasuje historii źródłowej DBK. Eksport służy archiwizacji — import kopii nie jest jeszcze zaimplementowany.

Poniższe instrukcje trwałego wdrożenia i automatycznej synchronizacji dotyczą osobnych `pilot/server.mjs` i `pilot/start.mjs`, nie aktualnego testowego `npm start`.

Gotowy formularz i proces pobierający historię DBK. Wykorzystuje istniejący adapter z `../server.mjs`; nie zmienia MCP ani konfiguracji wFirmy. Domyślny start dotychczasowej integracji pozostaje bez zmian.

## Funkcje

- Logowanie hasłem panelu; klucze DBK pozostają wyłącznie na serwerze.
- Wybór jednego uprawnionego auta, potem stałe przypisanie.
- Formularz: numer, przychód i waluta, dwa adresy, współrzędne placów, promienie, planowane terminy.
- Pobieranie jednej godziny historii na minutę, z 15-minutowym nakładaniem i usuwaniem duplikatów. Początek śledzenia dwie godziny przed załadunkiem, koniec dwie godziny po planowanym rozładunku. Serwer musi działać bez usypiania.
- Postój wymaga przynajmniej dwóch próbek z prędkością ≤3 km/h obejmujących ≥5 minut. Przerwa >10 minut przerywa dowód ciągłości. Wykrycie jest szacunkiem obecności w strefie, nie potwierdzeniem wykonania załadunku.
- Kilometry: różnica liczników CAN, ewentualnie GPS z jawnym oznaczeniem. Ujemne różnice i braki nie są zerowane. Zużycie paliwa: różnica licznika paliwa CAN.
- Plan kierowcy TXT do sprawdzenia i wysłania przez dispo, pauza pobierania, eksport JSON z próbkami i zleceniami.
- Dane zapisane atomowo w pliku na trwałym dysku; restart nie zeruje postępu. Jeden proces / jedna instancja.

## Uruchomienie lokalne (Node 20+)

Ustaw w prywatnym środowisku procesu `DBK_API_KEY`, `DBK_API_SECRET`, `PILOT_PASSWORD` (co najmniej 24 znaki) i `PILOT_DATA_DIR` (bezwzględna ścieżka do trwałego katalogu). Opcjonalnie `DBK_API_BASE_URL=https://gps.grupadbk.com/webapi`.

Uruchom z głównego katalogu repozytorium:

```sh
node pilot/server.mjs
```

Otwórz `http://127.0.0.1:8787`. Domyślnie panel dostępny jest tylko na tym komputerze. Proces musi pozostać uruchomiony do automatycznej synchronizacji. Nie zapisuj sekretów w kodzie lub repozytorium.

## Uruchomienie obok istniejącej integracji na Render

Przed zmianą komendy startowej potrzebna jest działająca stale instancja z trwałym dyskiem. Nie zapisuj zleceń na efemerycznym systemie plików. Koszt instancji i dysku wymaga osobnej decyzji właściciela.

1. Podłącz trwały dysk, np. `/var/data`.
2. Zachowaj dotychczasowe zmienne DBK, wFirma i OAuth. Dodaj `PILOT_DATA_DIR=/var/data/tcog`, `PILOT_PASSWORD` oraz `PILOT_ORIGIN=https://asystent-tcog.onrender.com`. Jeśli platforma nie udostępnia `RENDER_DISK_MOUNT_PATH`, ustaw ją na rzeczywisty punkt montowania dysku.
3. Po scaleniu kodu zmień start na `node pilot/start.mjs`. Health check pozostaje `/health`. Nie skaluj do wielu instancji.
4. Otwórz główny adres serwera; zaloguj się hasłem panelu. Dotychczasowe trasy MCP i OAuth są kierowane do istniejącej aplikacji.
5. Wybierz auto z DBK i dodaj jedną trasę. Porównaj wynik z danymi kierowcy, zanim użyjesz go w rozliczeniach.

Nie wdrożono automatycznie płatnej infrastruktury. W kodzie nie ma prawdziwych kluczy ani danych pojazdów.

## Testy i ograniczenia pilotażu

```sh
node --test test.mjs pilot/test.mjs
```

Testy pokrywają dopasowanie postojów, luki, cofnięcie licznika, duplikaty, walidację, uwierzytelnienie oraz zapis i wznowienie. Test procesu używa zastępczego DBK; sprawdzenie rzeczywistej trasy nadal wymaga wyboru auta i zlecenia.

Adres nie jest automatycznie zamieniany na współrzędne: plac wskazuje dispo. Jeden załadunek i jeden rozładunek, maks. 48 godzin; do 100 zleceń. Przyciski Edytuj i Usuń pozwalają poprawiać i usuwać zlecenia. Zmiana terminu zeruje próbki oraz postęp pobierania danego zlecenia; pozostałe zmiany przeliczają istniejące próbki. Usunięcie wymaga potwierdzenia w panelu. Nakładające się terminy są odrzucane. Brak automatycznych kosztów, pełnej rentowności i przypisania pustych kilometrów między zleceniami. Opóźnione dane starsze niż nakładka wymagają kontrolowanego ponownego importu; puste okna są oznaczane, a nie uznawane za postoje. Eksport zawiera dane lokalizacyjne — przechowuj go prywatnie. Kopię pliku danych należy wykonywać regularnie; eksport nie zastępuje automatycznej kopii zapasowej.

Po niekontrolowanym przerwaniu procesu może pozostać `pilot.lock`. Administrator może usunąć wyłącznie ten plik dopiero po potwierdzeniu, że poprzedni proces nie działa. Nigdy nie usuwaj `pilot.json`, aby odblokować uruchomienie.
