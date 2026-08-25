# Cribro Sift

> Mów swobodnie. Zostaje esencja.

Dyktowanie głosowe dla macOS w miejsce Wispr Flow. Trzymasz dwa klawisze, mówisz
tak, jak myślisz — z zacięciami i poprawkami w połowie zdania. Puszczasz klawisze,
a czysty tekst ląduje pod kursorem i w schowku.

`cribro` (łac.) — *przesiewam*.

---

## Jak to działa w środku

```
   ⌃ + ⌥ (trzymasz)
        ↓
   nagranie WAV 16 kHz mono          ← ginie zaraz po transkrypcji
        ↓
   KROK 1 — transkrypcja             ← Gemini albo OpenAI
   „yyy dobra to to znaczy chciałem powiedzieć że to działa eee"
        ↓
   KROK 1½ — polecenie               ← lokalnie, bez modelu, bez sieci
   „zrób checklistę: mleko, chleb"   → fraza odcięta, sito dostaje „mleko, chleb"
        ↓
   KROK 2 — sito                     ← Gemini, OpenAI albo Claude
   „Chciałem powiedzieć, że to działa."
        ↓
   wklejenie pod kursor  +  schowek  +  wpis w historii
```

Dwa osobne wywołania do dwóch osobnych modeli — celowo. Transkrypcja ma być
**wierna** (zostawia „yyy" i powtórzenia), a dopiero sito je usuwa. Dzięki temu
w historii widać dokładnie, co odpadło.

---

## Instalacja

### 1. Zbuduj aplikację

```bash
cd cribro-sift
npm install
npm run identity   # raz na tym Macu
npm run app
```

`npm run app` robi dwie rzeczy: pakuje aplikację do `~/CribroSift-build/`
i podpisuje ją. Podpis jest konieczny, żeby macOS zapamiętał zgody —
bez niego pytałby o mikrofon przy każdym uruchomieniu.

`npm run identity` zakłada certyfikat, którym potem podpisywane są wszystkie
buildy. Robi się to **raz**, ale pominąć się tego nie da — i warto wiedzieć
dlaczego. macOS zapamiętuje zgodę „Dostępność” razem z wymaganiem, po którym
rozpoznaje aplikację:

```
podpis ad-hoc  →  designated => cdhash H"6d31d852…"
certyfikat     →  designated => identifier "com.cribro.sift"
                                and certificate root = H"fd10f086…"
```

Cdhash to skrót zawartości bundla. Zmiana jednej linijki kodu zmienia
`app.asar`, `app.asar` zmienia cdhash — a wtedy dla systemu **to już inny
program**. Wpis w Ustawieniach zostaje i przełącznik dalej wygląda na
włączony, ale zgoda nie działa i skrót milczy. Odcisk certyfikatu przy
przebudowie się nie zmienia, więc zgodę przyznaje się raz i ma spokój.

Certyfikat leży w osobnym pęku kluczy `~/Library/Keychains/cribro-sign.keychain-db`,
nie w pęku logowania. Jest ważny 10 lat i nie nadaje się do rozdawania
aplikacji innym ludziom — do tego potrzebny jest Developer ID i notaryzacja.

### 2. Przenieś do Aplikacji

```bash
npm run deploy
open -a "Cribro Sift"
```

`npm run deploy` robi trzy rzeczy, z których samo kopiowanie robi jedną:
przenosi bundle (`ditto`, nie `cp` — zachowuje atrybuty, na których stoi
podpis), rejestruje go w **LaunchServices** i każe zaindeksować
**Spotlightowi**.

Te dwa ostatnie kroki nie są kosmetyką. Nowy bundle ma nowy numer i-węzła,
a indeks Spotlighta dalej opisuje ten skasowany — aplikacja jest wtedy
w `/Applications`, uruchamia się z Findera, ma ważny podpis **i nie da się
jej znaleźć ⌘spacją**. Wygląda to na zniknięcie aplikacji, a jest tylko
nieaktualnym indeksem. Skrypt sprawdza na koniec, czy indeks naprawdę
usiadł, zamiast założyć, że usiadł.

Przy pierwszym uruchomieniu macOS może pokazać ostrzeżenie, że aplikacja
pochodzi od niezidentyfikowanego dewelopera. Wtedy: **kliknij prawym
przyciskiem na ikonę → Otwórz → Otwórz**. To trzeba zrobić raz.

### 3. Uprawnienia

| Zgoda | Kiedy | Gdzie w razie problemu |
| --- | --- | --- |
| **Mikrofon** | macOS zapyta przy pierwszym nagraniu | Ustawienia systemowe → Prywatność i ochrona → Mikrofon |
| **Dostępność** | trzeba włączyć ręcznie | Ustawienia systemowe → Prywatność i ochrona → Dostępność |

Mikrofon jest obowiązkowy. **Dostępność jest opcjonalna** — bez niej działa
przycisk „Dyktuj" w oknie, a tekst ląduje tylko w schowku. Z nią działa skrót
⌃+⌥ z dowolnej aplikacji i automatyczne wklejanie pod kursor.

Po włączeniu Dostępności wróć do okna Cribro — aplikacja sama przejmie skrót,
gdy tylko okno dostanie fokus.

### 4. Klucze API

**Ustawienia → Silniki.** Każdy krok ma własny wybór dostawcy, modelu i klucza.

| Dostawca | Skąd klucz | Obsługuje |
| --- | --- | --- |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | oba kroki |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | oba kroki |
| Anthropic Claude | [console.anthropic.com](https://console.anthropic.com/settings/keys) | tylko sito |

Jeśli oba kroki chodzą na tym samym dostawcy, **klucz wystarczy wpisać raz** —
drugi krok sam go znajdzie. Klucze można też podać w zmiennych środowiskowych
`GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.

Przycisk **Sprawdź** przy każdym kroku wysyła prawdziwe żądanie do dostawcy
i pokazuje odpowiedź. Warto go użyć zanim powiesz pierwsze zdanie.

Klucze leżą w `~/Library/Application Support/Cribro Sift/settings.json`
i nigdzie stąd nie wychodzą poza wywołania do wybranego dostawcy.

---

## Codzienne użycie

Jeden komplet klawiszy, dwa sposoby mówienia:

| Gest | Co robi | Kiedy |
| --- | --- | --- |
| **Przytrzymaj ⌃+⌥** | nagrywa, dopóki trzymasz; puszczasz — sito pracuje | jedno zdanie w biegu |
| **Stuknij ⌃+⌥ dwa razy** | nagrywanie zostaje włączone, **ręce wolne** | dłuższa wypowiedź, spotkanie |
| **Stuknij ⌃+⌥ ponownie** | kończy tryb bez trzymania i przesiewa | — |
| **Esc** | przerywa i **kasuje nagranie** — nic nie idzie do transkrypcji | rozmyśliłeś się |

O tym, czy stuknięcie było stuknięciem, decyduje czas: krócej niż **220 ms**
to stuknięcie, dłużej — trzymanie. Drugie stuknięcie liczy się, jeśli padnie
w ciągu **450 ms**. Dzięki temu oba gesty mieszczą się na jednym komplecie
klawiszy i nigdy nie kolidują.

Escape działa też wtedy, gdy nagranie ruszyło przyciskiem „Dyktuj", z widgetu
albo z notatnika — silnik skrótu przejmuje takie nagranie jak własne.

Oba gesty są włączone **zawsze** i nie ma czego przestawiać: o sposobie
decyduje ręka, nie ustawienie. Wcześniej tryb bez trzymania dało się wyłączyć
przełącznikiem, a wtedy podwójne stuknięcie milczało bez wyjaśnienia —
przy jednym komplecie klawiszy to była opcja, której włączenia trzeba się
było domyślić.

Skrót to dwa **modyfikatory**, nie modyfikator plus znak: trzymanie ⌥+spacji
wsypywałoby spacje do aplikacji, do której właśnie mówisz. ⌃+⌥ nie generują
żadnego znaku. Bez zgody „Dostępność" zostaje przełącznik `⌃⌥Spacja`.

Podczas mówienia widać jedno okno — HUD nad Dockiem. Przez **pierwsze trzy
sekundy** jest pełną pigułką: fala głosu, napis „Słucham", zegar i podpowiedź,
czym zakończyć. Pigułka jest przy tym **mała** — o 30% mniejsza od kwadratu,
w którym mieściła się wcześniej. Pojawia się nad cudzym oknem w chwili, gdy
patrzy się w to okno, a nie w nią: ma potwierdzić, że mikrofon ruszył, a do
tego nie potrzeba miejsca, tylko widoczności — tę niesie ruch i kolor. Potem **osuwa się w stronę widgetu i gaśnie**, a nagrywanie widać
dalej — na znaczku widgetu, który wtedy pokazuje mikrofon, oddycha
i **reaguje na głos**. Powód jest prosty: te napisy są potwierdzeniem, że
mikrofon ruszył, i po trzech sekundach przestają cokolwiek wnosić — a zasłaniają
okno, do którego się właśnie mówi. Zostaje to, co nadal coś znaczy: że
nagrywanie trwa i że mikrofon słyszy. Jedno miejsce, nie dwa: pigułka i osobne
pulsujące kółko obok niej były tym samym komunikatem powiedzianym dwa razy.

Poziom głosu wędruje z HUD-a (tylko on ma dostęp do mikrofonu) przez proces
główny do widgetu, dwadzieścia razy na sekundę. Gdy widget jest wyłączony, nie
ma komu przekazać pałeczki — pigułka kurczy się wtedy do własnego kółka
i zostaje na ekranie. Każda zmiana stanu („Przesiewam", „W schowku") rozwija
pigułkę z powrotem.

W tym zwiniętym widoku **puls bije mocno**: dwa pierścienie zamiast jednego,
rozchodzące się dwa i pół raza dalej niż wcześniej, w tempie tętna. To jest
w tej chwili jedyna rzecz na ekranie, która mówi „mikrofon nadal słucha" —
poprzedni puls gasł w promieniu ośmiu pikseli i przy mniejszej pigułce byłby
już tylko domysłem.

**Kolor stanu.** Zieleń w Cribro znaczy „gotowe" i tylko to. Z chwilą, gdy
mikrofon słucha, wszystko, co o tym mówi — znaczek w pasku menu, widget, kropka
stanu w oknie i cała pigułka — przechodzi na **fiolet**. Odpowiedź na pytanie
„czy to nagrywa?" jest przez to widoczna kątem oka, bez czytania czegokolwiek.
Bursztyn zostaje przesiewaniu, czyli chwili między jednym a drugim.

Aplikacja żyje w pasku menu. Ikona pokazuje stan: sito czeka, **fioletowe koło
z falą słucha**, bursztynowe przesiewa, miętowy znacznik oznacza gotowe. Kliknięcie
w znaczek **rozwija menu** i nic poza tym — okno otwiera dopiero pozycja
„Otwórz Cribro Sift". Po znaczek sięga się najczęściej po gęstość sita, język
albo szybką notatkę, a całe okno wjeżdżające na ekran przy każdym takim
sięgnięciu było skutkiem ubocznym, nie odpowiedzią na kliknięcie.

**Escape zamyka okno.** Zdejmuje jednak po jednej warstwie, od wierzchu:
najpierw otwarte menu, potem trwające nagranie, potem pisanie w polu (pierwszy
Escape wychodzi z pola, dopiero drugi zamyka), potem **kartki leżące na
pulpicie**, a na końcu samo okno. Odruchowe „escape" w środku notatki nie ma
prawa sprzątnąć okna sprzed nosa. Okno główne **chowa się do paska menu**,
nie znika — aplikacja czeka dalej na skrót. Notatnik i pojedyncza notatka
zamykają się na dobre; notatka jest zapisana.

Ta sama umowa obowiązuje **wszędzie**: Escape zamyka szybką notatkę, okienko
tekstu z ekranu i każde inne okno dialogowe, a kartki z pulpitu zdejmuje
także wtedy, gdy fokus siedzi w **cudzej aplikacji** — bo tam się właśnie
pracuje, gdy one leżą na wierzchu. Ta ostatnia droga wymaga zgody
**„Dostępność"**: bez niej Cribro nie widzi Escape'u spoza własnych okien,
a zabranie tego klawisza całemu systemowi na stałe zamykałoby cudze okna
dialogowe zamiast naszych kartek.

Pas boczny w oknie **zwija się do samych ikon** — uchwyt pojawia się na jego
krawędzi, gdy kursor wejdzie w okno. Tak samo zwija się **lista notatek**:
uchwyt siedzi w połowie wysokości, na styku listy i notatki, a przy zwiniętej
liście zostaje widoczny na stałe, żeby droga powrotna nie była niewidzialna.
To samo robi strzałka w pasku narzędzi notatki i **⌘⇧L**. Oba stany zwinięcia
zostają między uruchomieniami.

### Przewodnik

Cribro **nie tłumaczy się samo** i to nie jest wada interfejsu, tylko skutek
tego, czym jest: wszystko dzieje się poza oknem. Skrót działa w cudzej
aplikacji, znaczek pływa nad wszystkim, przesiany tekst ląduje pod kursorem
gdzie indziej. Kto otworzy okno po pierwszym uruchomieniu, widzi pustą listę
przesianych wypowiedzi i nie ma z czego wywnioskować, że trzeba przytrzymać
dwa klawisze i zacząć mówić.

Stąd **osiem slajdów**, które pokazują się raz, same, przy pierwszym starcie:

| # | Slajd | O czym |
| --- | --- | --- |
| 1 | Sito | co ta aplikacja właściwie robi |
| 2 | Skrót | ⌃⌥ trzymane i stuknięte dwa razy, Escape kasuje |
| 3 | Gęstość | zgrubne · średnie · drobne |
| 4 | Polecenia | „zrób z tego maila" i własne frazy |
| 5 | Notatki | Notatnik, szybka notatka, dyktowanie do notatki |
| 6 | Widget | znaczek, taca, notatki na wierzchu |
| 7 | Tekst z ekranu | zaznaczenie kawałka cudzego okna |
| 8 | Klucz | jedyna rzecz, bez której nic nie ruszy |

**Każdy slajd ma ruchomy rysunek** i to nie jest ozdoba: wszystkie te funkcje
SĄ ruchem — przytrzymanie klawiszy, przesypywanie się przez sito, rozkładanie
tacy, zaznaczanie prostokąta na ekranie. Nieruchomy obrazek każdej z nich
trzeba opisać słowami, a opis czyta się dłużej, niż trwa sam gest. Sceny są
rysowane w SVG i animowane w CSS-ie (`js/onboarding.js` i `css/onboarding.css`),
bez żadnej biblioteki; kto wyłączył ruch w systemie, dostaje je nieruchome.

Sceny chodzą **wyłącznie na widocznym slajdzie**. Animacja CSS nie zatrzymuje
się od tego, że element jest przezroczysty, więc osiem scen liczyłoby się
naraz przez cały czas — a przy okazji: zdjęcie animacji z niewidocznych
slajdów sprawia, że powrót na slajd zaczyna ruch od początku, zamiast złapać
go w połowie.

Zapamiętane jest samo **„pokazał się"**, nie „obejrzany do końca": kto zamknął
przewodnik na drugim slajdzie, też podjął decyzję, a okno wracające przy
każdym starcie, dopóki nie klikniesz go do końca, jest natrętne, a nie
pomocne. Wraca się do niego **przyciskiem na dole paska bocznego**, który stoi
tam zawsze, oraz pozycją *Przewodnik* w menu *Okno*. Escape zamyka slajdy,
a nie okno — nasłuch idzie w fazie przechwytywania i zabiera klawisz reszcie
aplikacji.

Ostatni slajd prowadzi wprost do **Ustawień**, bo bez klucza do modelu
wszystko, co pokazał, nie ma czym pracować.

### Konflikty skrótów

*Ustawienia → Skrót → Sprawdź konflikty* mówi, czy skrót nie wchodzi komuś
w drogę. Sprawdzenie ma trzy źródła i każde widzi co innego:

- **skróty systemowe** — czytane z `com.apple.symbolichotkeys`; fabrycznych,
  nietkniętych, nie ma w tym pliku, więc te najczęstsze trzymamy dodatkowo
  na krótkiej liście w kodzie;
- **inne aplikacje** — nie ma API, które by je wyliczyło, jest za to test
  wprost: spróbować zarejestrować skrót i zobaczyć, czy system pozwoli;
- **własne skróty Cribro** — te po prostu znamy.

Czego to **nie wykryje**: aplikacji, które podsłuchują klawiaturę zamiast
rejestrować skrót globalny — robi tak wiele narzędzi do dyktowania. Takiego
skrótu nie widzi żaden interfejs systemu, więc nie widzi go też Cribro.

### Języki

Cribro dyktuje **dwujęzycznie** i to jest ustawienie domyślne: polskie zdanie
z angielskim terminem w środku zostaje dokładnie tym, czym było.

To nie to samo, co rozpoznawanie automatyczne. Automat wybiera **jeden** język
dla całego nagrania, więc drugi albo przekręca, albo tłumaczy. Para języków
mówi modelowi wprost, że przeplatanie jest zamierzone — i zakazuje tłumaczenia
w którąkolwiek stronę.

| Tryb | Co robi | Kiedy |
| --- | --- | --- |
| **Dwujęzycznie** | dwa wybrane języki naraz, przełączanie w środku zdania | praca, żargon, nazwy narzędzi |
| **Jeden język** | kod języka idzie do dostawcy wprost | wiadomo, co padnie |
| **Automat** | model rozpoznaje sam | nie wiadomo, co padnie |

Ustawisz to w zakładce **Sito → Język**, z paska menu albo jednym kliknięciem
na tacy widgetu. Ten sam opis języka dostają **oba kroki** — transkrypcja i sito.
Gdyby dostał go tylko pierwszy, sito „poprawiłoby" angielskie wtrącenia
na polskie, bo bez tej wiedzy wyglądają jak przekręcenia.

Przy jednym języku Whisper dostaje kod wprost; przy dwóch kod **nie idzie**,
bo narzucony kazałby mu zmielić drugi język na pierwszy.

### Język interfejsu

Polski i angielski, przełącznik w *Ustawienia → Zachowanie*. Zmienia napisy
w oknach, w pasku menu i na widgecie — język dyktowania ustawia się osobno.
Źródłem jest polski; angielski to jeden słownik w `src/shared/strings.js`,
a napis, którego w nim nie ma, zostaje po polsku zamiast zniknąć.

### Gęstość sita

Jedyne pokrętło. Zmienisz je w zakładce **Sito** albo z paska menu.

- **Zgrubne** — znikają tylko zacięcia i „yyy", reszta słowo w słowo
- **Średnie** — czysta wypowiedź, twoja składnia i rejestr *(domyślne)*
- **Drobne** — zwięźle i formalnie, gotowe do wysłania

### Ziarna

Słowa, których sito nigdy nie tknie: nazwiska, nazwy produktów, żargon.
Jeśli transkrypcja usłyszy coś fonetycznie zbliżonego, sito zapisze wersję
z listy.

### Polecenia

Zakładka **Polecenia**. Powiesz „zrób checklistę: mleko, chleb i masło" —
dostaniesz listę zadań, a nie zdanie o checklistach.

To jedyny wyłom w zasadzie, na której stoi całe sito: *nie odpowiadasz na to,
co usłyszałeś*. Dlatego nie zgaduje go żaden model. Polecenie nie jest
instrukcją, którą model postanawia wykonać — jest frazą zapisaną przez ciebie,
która na jedno dyktowanie przestawia reguły sita.

Polecenie ma trzy części:

| Część | Co to |
| --- | --- |
| **Wywołanie** | frazy, po których rusza — „zrób checklistę", „make a checklist" |
| **Wytyczna** | co sito ma z materiałem zrobić |
| **Ujście** | dokąd trafia wynik: pod kursor, do notatki, do nowej notatki, do samego schowka |

Do tego wybór gęstości — polecenie może przesiać drobniej, nie ruszając
pokrętła w **Sicie**.

W zestawie startowym są trzy, wszystkie zmieniające tylko formę: **Checklista**,
**Punkty** i **Mail**. Polecenia zmieniające ujście zakładasz sam — bo to one
przenoszą tekst tam, gdzie go nie widać.

#### Dwie warstwy rozpoznawania

**Lokalna.** Zapisana fraza dopasowana co do słowa, bez modelu i bez sieci.
Odcina wywołanie z transkryptu, zanim cokolwiek pojedzie do sita — więc sito
nie dostaje żadnego polecenia, tylko czysty materiał i inne reguły. Zakaz
„NIE ODPOWIADASZ" zostaje nietknięty w swoim brzmieniu.

**Sito.** Gdy lokalnie nic nie trafiło, do promptu jedzie **zamknięta lista**
wywołań: model wolno mu rozpoznać odmianę albo przestawkę („a zrób mi z tego
listę"), ale nic spoza listy poleceniem nie jest. To samo wywołanie API,
więc bez grosza i bez milisekundy więcej.

Rozpoznanie po stronie sita ma **mniejsze prawa**: może zmienić formę tekstu,
ale nigdy ujścia. Rozmycie nie ma prawa przenieść wypowiedzi tam, gdzie jej
nie widać.

#### Kiedy polecenie NIE rusza

Cztery reguły, wszystkie przeciw temu, żeby zwykłe zdanie zamieniło się
w listę zadań i wpadło komuś w rozmowę:

1. **Tylko krawędź.** Początek albo koniec wypowiedzi, nigdy środek.
2. **Samodzielne zdanie.** Między frazą a materiałem musi stać granica —
   przecinek, dwukropek, kropka albo nowa linia. „Zrób punkty kontrolne na
   przeglądzie" nie jest poleceniem, tylko zdaniem o punktach kontrolnych.
3. **Musi mieć na czym pracować.** Sama fraza „zrób checklistę" bez niczego
   dalej zostaje zwykłym zdaniem — bo tak się pisze do kolegi.
4. **Furtka.** Wypowiedź zaczynająca się od „cytuję", „słowo w słowo" albo
   „bez polecenia" nie uruchamia niczego. Frazy da się zmienić w zakładce.

Wypowiedź całkiem bez interpunkcji („zrób checklistę mleko chleb") nie trafia
lokalnie — i tak ma być. Łapie ją sito, które czyta zdanie ze zrozumieniem;
dopasowanie lokalne ma być **pewne**, a nie domyślne.

#### Widać i da się cofnąć

Polecenie to jedyne miejsce, w którym aplikacja robi z tekstem coś, o co jej
w tym zdaniu wprost nie prosiłeś. Więc:

- **pigułka HUD-a** pokazuje nazwę polecenia w trakcie przesiewania — wiesz,
  zanim tekst wpadnie pod kursor;
- **wpis w Przesianych** ma kaflik z nazwą i przycisk **Bez polecenia**, który
  przesiewa zachowany surowy transkrypt jeszcze raz, tym razem dosłownie.
  (Wymaga włączonego „Zachowaj surowy transkrypt" — bez niego nie ma z czego.)

#### Próba

Pole na dole zakładki. Wpisujesz zdanie tak, jak byś je powiedział, i widzisz,
czy polecenie ruszy, które i co zostanie z wypowiedzi. Sprawdza samo
rozpoznanie — sita nie woła, więc odpowiada od razu i nic nie kosztuje.

#### Komendy formatujące to co innego

„nowy akapit", „punkt", „kropka" działają zawsze i w środku zdania — sito zna
je z kontraktu i nie da się ich zmienić. Zakładka pokazuje je na dole, bo do
tej pory nie było ich widać nigdzie, choć chodzą przy każdym dyktowaniu.

### Notatki

Zakładka **Notatki** w oknie głównym — otwiera się tak samo jak Start,
Przesiane czy Sito. Wcześniej ta jedna pozycja na pasku bocznym zachowywała
się inaczej niż wszystkie pozostałe: otwierała okno obok, zamiast zmienić widok.

Schemat widoku jest stały i płaski, żeby jedno spojrzenie wystarczyło:

```
┌── lista ────────────┬── notatka ───────────────────────┐
│ szukaj  ·  + Nowa   │ pasek narzędzi                   │
│ ─────────────────── │ ──────────────────────────────── │
│ tytuł               │                                  │
│ dwie linijki treści │   tekst notatki (edytor)         │
│ kiedy · ile słów    │                                  │
│ …                   │ ──────────────────────────────── │
│                     │ stan zapisu · słowa · podpowiedź │
└─────────────────────┴──────────────────────────────────┘
```

Lista **rozkłada się i składa** strzałką na początku paska narzędzi. Złożona
odchyla się w bok i znika, a edytor w tym samym ruchu przejmuje całą szerokość
okna — notatka pisana na pełnym oknie jest jednym kliknięciem stąd. Stan zostaje
między uruchomieniami, a założenie nowej notatki rozkłada listę z powrotem.

**Lista dzieli się na trzy przegródki**: *Przypięte*, *Szybkie notatki*
i *Notatki* — w tej kolejności. Przypięta szybka notatka idzie na górę,
a nie zostaje wśród szybkich: przypięcie znaczy „mam to mieć przed oczami",
nie „posortuj mnie". Nagłówek przegródki jest zarazem klapką — kliknięcie
zwija ją i chowa kafle, a stan zostaje między uruchomieniami. Szukanie
przegródek nie słucha: fraza pokazuje wszystko, co pasuje, także w tych
zwiniętych tydzień temu.

**Przypinanie z listy**: pinezka pokazuje się na kaflu pod kursorem
i zostaje widoczna, gdy notatka jest przypięta. To ten sam przełącznik,
co pinezka w pasku narzędzi notatki — tyle że bez otwierania notatki.

**Podwójne kliknięcie w tytuł na kaflu zmienia tytuł.** Tytuł nie jest
osobnym polem — jest pierwszą linią notatki — więc zmiana wchodzi prosto
w tekst i widać ją też w edytorze obok. Forma linii zostaje: nagłówek
zaczynający się od `#` dalej jest nagłówkiem, punkt listy dalej punktem.
Enter kończy, Escape cofa.

**Podwójne kliknięcie w resztę kafla otwiera notatkę w osobnym okienku** —
bez listy, bez wyszukiwarki, sama notatka. Notatka ze spotkania ma prawo stać obok
rozmowy, a nie w środku okna, które trzeba przełączać. Kilka notatek naraz
to kilka okienek; to samo robi przycisk z ramką okna na pasku narzędzi.
Ta sama notatka otwarta w kilku miejscach naraz zmienia się wszędzie
jednocześnie.

Pełny **Notatnik w osobnym oknie** dalej jest: *menu Plik → Notatnik* (⌘⇧O)
albo pasek menu — z tymi samymi przegródkami, pinezką na kaflu i zmianą
tytułu. Tytuł bierze się z pierwszej linii — nikt w trakcie rozmowy nie
wymyśla nazwy dla notatki — a kto chce inny, klika w niego dwa razy. Zapis
jest automatyczny, pół sekundy po tym, jak przestaniesz pisać.

Najważniejszy przycisk to **Dyktuj**: nagrywa i dopisuje przesiany tekst
na końcu otwartej notatki jako nowy akapit, zamiast wklejać go pod kursor.
Sam przycisk jest wtedy wskaźnikiem stanu — „Słucham…", potem „Przesiewam…".
Tekst trafia też do schowka.

**Pasek narzędzi notatki** czyta się w **trzech grupach**, rozdzielonych
kreską, i ten podział jest całą jego instrukcją: co działa na tekst pod
kursorem, co na całą notatkę, a co jest nieodwracalne.

| Grupa | Przycisk | Co robi |
| --- | --- | --- |
| | Dyktuj | nagrywa i dopisuje przesiany tekst na końcu notatki |
| **Piszę** | B · I | pogrubienie · kursywa |
| | H | menu bloków: nagłówek 1, 2, 3, nagłówek składany, linia rozdzielająca |
| | listy · cytat | lista, lista zadań, cytat |
| | Linie | wyrównanie tekstu: do lewej, do środka, do prawej, wyjustowane |
| | Zegar (⌘T) | wstawia bieżącą godzinę w miejscu kursora |
| **Notatka** | Sito | przepuszcza **całą** notatkę przez sito; można cofnąć |
| | Okno | otwiera tę notatkę w osobnym okienku |
| | Karteczka | „Widoczna w widgecie" — kładzie notatkę na wierzchu |
| | Pinezka | przypina notatkę do przegródki „Przypięte" na górze listy |
| | Udostępnij | Notatki Apple · Notion · kopiuj tekst · kopiuj jako Markdown · zapisz PDF · zapisz .md |
| **Osobno** | Kosz | kasuje notatkę |

Kosz stoi za własną kreską i na samym końcu, bo jako jedyny w tym pasku
jest nieodwracalny — a wcześniej sąsiadował z pinezką. Dwa przełączniki
(„na wierzchu", „przypięta") mówią o stanie notatki jednym znakiem, więc
włączone dostają **obwódkę w kolorze wiodącym**, nie samo przyciemnione
tło: tło przy ciemnym motywie nie odróżniało się od zwykłego najechania
kursorem. Ten sam pasek stoi w Notatniku i w zakładce Notatki — ta sama
notatka wygląda w obu miejscach tak samo.

Pod paskiem stoi **metryczka notatki**: w której szufladzie leży i czego
dotyczy. To nie są czynności, więc nie ma ich w pasku — pasek jest od tego,
co się robi, a metryczka od tego, czym notatka jest.

**Wyszukiwanie:** pole nad listą albo ⌘F. Trafienia są podświetlone
w tytułach i w zajawkach.

### Szuflady i etykiety

Dwie różne rzeczy, choć obie porządkują — i dlatego są dwie, a nie jedna
użyta dwa razy:

| | Ile | Co mówi |
| --- | --- | --- |
| **Szuflada** | jedna albo żadna | **gdzie** notatka leży: „Klient Nowak", „Rekrutacja" |
| **Etykiety** | dowolnie wiele | **czego** dotyczy: `#pilne`, `#rozliczenia` |

Notatka ze spotkania należy do jednego projektu i dotyczy trzech spraw naraz.
Jedno pole tego nie uniesie: albo trzeba by wybrać jedną sprawę, albo szuflad
zrobiłoby się tyle, ile kombinacji.

**Szufladę** wybiera się przyciskiem w metryczce notatki. Menu pokazuje te,
które już są, plus „Nowa szuflada…" — a nazwę nowej wpisuje się wprost w ten
sam przycisk, w którym potem stoi. Osobne okienko z pytaniem byłoby trzecim
oknem dla jednego słowa.

Nad listą notatek stoi wtedy **pas szuflad** z licznikami; kliknięcie zawęża
listę, drugie kliknięcie w tę samą wraca do wszystkich. Pas pokazuje się
dopiero wtedy, gdy jest choć jedna szuflada — pusta listwa nad listą nie
mówi nic. Wybrana szuflada zostaje między uruchomieniami.

Szuflad nie ma osobnego rejestru: powstają z samych notatek. Szuflada, z której
wyszła ostatnia notatka, przestaje istnieć sama — nie ma czego sprzątać
i nie ma czemu rozjechać się z tym, co naprawdę leży w notatkach.

**Etykiety** dopisuje się w polu „+ etykieta" w metryczce. Enter albo przecinek
kończy jedną, Backspace w pustym polu zdejmuje ostatnią. Widać je na kaflu
na liście, a kliknięcie w kafelek etykiety wpisuje ją do wyszukiwarki — bo po
to się na nią patrzy: „pokaż mi resztę tych".

Szukanie rozumie `#etykieta` jako etykietę, a nie jako słowo w treści.
Można łączyć: `#pilne raport` znaczy „notatki z etykietą pilne, w których
pada słowo raport". Reszta frazy szuka też w nazwie szuflady.

Szuflada i etykiety **jadą do chmury** razem z notatką (kolumny `folder`
i `tags`, patrz `supabase/schema.sql`). Jeśli baza jest starsza i tych kolumn
nie ma, synchronizacja wykrywa to przy pierwszym żądaniu i chodzi bez nich —
notatki jeżdżą normalnie, tyle że porządek zostaje na tym komputerze. Żeby
pojechał, wystarczy puścić `schema.sql` jeszcze raz; skrypt jest idempotentny.

### Formatowanie notatki

Edytor jest **zwykłym edytorem tekstu**: ⌘B pogrubia zaznaczone słowo i widać,
że jest pogrubione. Gwiazdek na ekranie nie ma.

| Skrót | Co robi |
| --- | --- |
| ⌘B · ⌘I | pogrubienie · kursywa |
| ⌘⇧H | nagłówek — ten bez numeru, po który sięga ręka (stopień drugi) |
| ⌘⇧1 · ⌘⇧2 · ⌘⇧3 | nagłówek pierwszego, drugiego i trzeciego stopnia |
| ⌘⇧E | nagłówek składany |
| ⌘⇧- | linia rozdzielająca |
| ⌘⇧8 | lista |
| ⌘⇧9 | lista zadań (kliknięcie w kwadrat odhacza) |
| ⌘⇧' | cytat |
| ⌘⇧J | wyjustowanie całej notatki (drugi raz wraca do lewej) |

**Trzy stopnie nagłówka, nie sześć.** Notatka ze spotkania nie ma głębszego
podziału niż część, podczęść i podpunkt, a czwarty stopień różniłby się od
trzeciego wyłącznie tym, że go nie widać. Nagłówek wklejony z cudzego pliku
jako `####` zjeżdża do trzeciego zamiast zniknąć.

**Linia rozdzielająca** to `---` na dysku i cienki gradient gasnący ku brzegom
na ekranie. Nie kreska przez całą szerokość i nie ramka: notatka nie jest
formularzem, a przerwa ma być przerwą, nie przegrodą.

**Nagłówek składany** chowa wszystko pod sobą aż do następnego nagłówka tego
samego albo wyższego stopnia. Notatka ze spotkania rośnie w dół przez godzinę
i po tej godzinie nikt nie chce widzieć jej całej naraz — chce widzieć spis
części i rozwinąć jedną. Klika się w strzałkę przy nagłówku.

Stan zwinięcia idzie **do pliku**, strzałką przy nagłówku:

```
## ▾ Ustalenia     rozwinięty
## ▸ Ustalenia     zwinięty
```

Trzymanie go obok, w widoku, znaczyłoby, że notatka otwarta w drugim oknie
albo nazajutrz rozkłada się z powrotem w całości. Znak jest zwykłym Unicode,
więc notatka w cudzym edytorze dalej czyta się jak nagłówek ze strzałką,
a nie jak zepsuty zapis. W eksporcie do PDF-u zwinięte sekcje są otwarte —
w pliku, który się drukuje, schowana treść byłaby treścią, której nikt nie
rozwinie. W Notion zostają składane naprawdę, bo Notion ma dokładnie to samo
pojęcie.

**Wyrównanie** (pasek narzędzi → ikona linii) jest cechą **całej notatki**,
nie zaznaczonego akapitu — tak samo jak krój i rozmiar. Do lewej, do środka,
do prawej albo wyjustowane; nagłówki i kreska zostają po swojemu, bo justowany
nagłówek rozjeżdża się na słowa. Wybór jedzie do chmury razem z notatką:
notatka wyjustowana na laptopie ma być wyjustowana także na drugim komputerze.

Odhaczone zadanie jest **przekreślone**: kwadrat zapala się na miętowo,
a przez tekst idzie kreska w tym samym kolorze i tekst gaśnie do odcienia
meta. Kreska jest w kolorze akcentu, nie tekstu — akcent znaczy „zrobione",
szara kreska znaczyłaby „skreślone, nieaktualne", a to dwie różne rzeczy.
Na dysku odhaczenie zostaje zwykłym `- [x]`, więc przeżywa wysłanie notatki
gdziekolwiek.

Na dysku notatka zostaje **Markdownem** — i to się nie zmieniło. Markdown
czyta się także wtedy, gdy nikt go nie renderuje, przeżywa kopiowanie
gdziekolwiek, jest tym, co oddaje „Kopiuj jako Markdown", i tym, do czego
dopisuje się dyktowanie. Tłumaczenie w obie strony siedzi w jednym pliku
(`src/shared/richtext.js`) i ma własny test: notatka przepuszczona tam
i z powrotem musi wyjść identyczna.

Bloki — nagłówek, cytat, listy — przebudowuje sam edytor, bez `execCommand`.
Powód jest konkretny: `formatBlock` i `insertUnorderedList` w Chromium potrafią
zostawić nowy blok **wewnątrz** akapitu (`<p><ul><li>…`), a taki zapis nie ma
odpowiednika w Markdownie — notatka traciłaby punktory przy pierwszym zapisie.

Wklejanie zawsze ląduje jako czysty tekst: notatka ma jeden krój i jeden
rozmiar, a ze strony WWW przyjechałoby wszystko naraz.

Enter w wierszu listy dokłada punkt, Enter w pustym punkcie listę kończy.
Dyktowanie do notatki, która kończy się punktem listy, **dokłada punkt**
zamiast rozbijać ją akapitem.

### Notatka na zewnątrz: PDF i Notion

Notatnik nie jest miejscem, w którym notatka kończy życie. **Udostępnij**
w pasku narzędzi ma teraz sześć wyjść: Notatki Apple, Notion, schowek jako
tekst, schowek jako Markdown, plik PDF i plik `.md`.

#### PDF

**Kartka jest jasna, choć aplikacja jest ciemna.** To nie przeoczenie: Cribro
jest ciemne, bo stoi obok pracy, przy której się siedzi, a PDF wychodzi na
zewnątrz — na papier, do skrzynki, do cudzego czytnika. Ciemny PDF wydrukowany
wychodzi czarnym prostokątem i zużywa pół kartridża.

Wygląd samego tekstu bierze się jednak z tego samego pliku co ekran
(`renderer/css/prose.css`). Zmienia się **wyłącznie paleta**, i to przez
podmianę tokenów motywu, nie przez drugą kopię reguł — dzięki temu zmiana
wyglądu nagłówka albo listy zadań wchodzi do PDF-u sama. Na górze kartki stoi
metryczka: tytuł, data, szuflada i etykiety. Zwinięte sekcje są otwarte,
nagłówek nie zostaje sam na końcu strony, a punkt listy nie pęka w pół.

Rysuje to osobne, niewidoczne okno — inaczej się nie da: `printToPDF` należy
do zawartości okna, a okno aplikacji ma na ekranie swoją.

#### Notion

**Ustawienia → Notion.** Dwa pola i jeden przycisk. Notatka jedzie w jedną
stronę: Cribro niczego z Notion nie czyta i niczego nie uzgadnia — to jest
wyprowadzanie na zewnątrz, a nie druga chmura.

Idą **prawdziwe bloki**, nie sklejony tekst: nagłówki trzech stopni, listy
zwykłe i numerowane, listy zadań ze stanem odhaczenia, cytaty, linia
rozdzielająca, pogrubienie, kursywa i kod w linii. Nagłówek składany zostaje
składany naprawdę (`is_toggleable`) — to jedno z niewielu miejsc, gdzie oba
programy mają dokładnie to samo pojęcie.

Co trzeba mieć po stronie Notion:

1. **Integrację** — `notion.so/my-integrations` → „New integration". Z niej
   bierze się token `ntn_…`. To nie jest hasło do konta i samo z siebie nie
   daje dostępu do niczego.
2. **Stronę-rodzica** — tę, pod którą mają wpadać notatki. Wklej jej adres
   z przeglądarki; sam identyfikator też przejdzie.
3. **Udostępnienie tej strony integracji** — otwórz ją w Notion, „•••"
   w prawym górnym rogu → „Connections" → dodaj swoją integrację.

Krok trzeci jest tym, który wszyscy pomijają, i to on jest powodem, dla
którego pierwsza próba zwykle nie działa. Notion odpowiada wtedy „Could not
find page" — o stronie, na którą właśnie patrzysz. Przycisk **Sprawdź
połączenie** zadaje dokładnie to pytanie i mówi, co poprawić.

**Wysłana drugi raz notatka odświeża swoją stronę**, a nie robi drugiej obok.
Zakładka „która notatka dostała którą stronę" leży w ustawieniach tego
komputera i nie jedzie do chmury — mówi o cudzym Notion, a nie o treści
notatki. Strona skasowana w Notion nie blokuje niczego: następne wysłanie
robi nową.

### Pisownia

**Ustawienia → Pisownia.** Przełącznik „Sprawdzaj pisownię" podkreśla w notatce
i w szybkiej notatce słowa, których słownik nie zna. Sam z siebie nie zmienia
niczego — poprawki są pod **prawym przyciskiem myszy**: podpowiedzi na górze
menu, a pod nimi **„Naucz się tego słowa"** dla nazwisk, nazw własnych
i żargonu, który ma zostać jak jest.

To samo menu ma cofnij, wytnij, kopiuj i wklej — wcześniej prawy przycisk
w notatce nie robił nic, więc czerwona fala mówiła „jest błąd" i nie dawała
nic z tym zrobić. Przełącznik pisowni jest też na dole tego menu i w menu
**Edycja**, żeby dało się go wyłączyć bez chodzenia do Ustawień.

Językami rządzą dwa różne mechanizmy i dlatego karta wygląda inaczej zależnie
od systemu:

| System | Kto sprawdza | Języki |
| --- | --- | --- |
| **macOS** | system (ten sam co w Mail, Pages, Notatkach) | rozpoznaje sam z pisanego tekstu; listę ustawia się w *Ustawieniach systemowych → Klawiatura → Tekst* |
| Windows, Linux | Chromium w środku Electrona | z ustawień dyktowania albo wybrane ręcznie w karcie |

Na macOS nie ma w karcie wyboru języków, bo nie byłoby czym sterować:
`setSpellCheckerLanguages` jest tam pustym wywołaniem. Pokrętło, które nic nie
robi, jest gorsze niż jego brak. Nauczone słowa idą przy okazji do słownika
systemowego, więc rozpoznaje je potem także reszta aplikacji.

Nazwy własne, których sito ma nigdy nie tknąć, to osobna sprawa — na to są
**Ziarna**. Pisownia mówi o tym, co widzisz, ziarna o tym, co robi model.

### Szybka notatka

Osobne, **małe okno** i nic poza polem tekstowym: jedno zdanie rzucone
w trakcie rozmowy nie potrzebuje listy notatek ani paska narzędzi. Otwiera je
taca widgetu, pasek menu albo przycisk *Wypróbuj* w Ustawieniach.

| Klawisz | Co robi |
| --- | --- |
| ⌘⏎ | zapisuje i zamyka |
| Esc | to samo — puste okno nie zostawia po sobie notatki |
| Esc w trakcie nagrywania | kasuje nagranie, okno zostaje |

Przycisk **Dyktuj** działa tak samo jak w Notatniku: przesiany tekst dopisuje
się do notatki. Zapisuje do tej samej szuflady, więc notatka czeka potem
w Notatniku — we **własnej przegródce „Szybkie notatki"**, oddzielonej kreską
od zwykłych notatek. Myśl rzucona w biegu ma inny ciężar niż notatka ze
spotkania; w jednym ciągu dziesięć takich myśli spychało tę jedną, po którą
się przyszło. Z klawiatury: **⌘⇧N** z menu aplikacji. Skrótu globalnego,
działającego spoza Cribro, jeszcze nie ma; miejsce na niego czeka
w *Ustawienia → Skrót*.

**Notatki Apple** dostają pierwszą linię jako tytuł, resztę jako treść.
Przy pierwszym wysłaniu macOS zapyta o zgodę na sterowanie aplikacją Notatki.
Jeśli odmówisz, znajdziesz to w *Ustawienia systemowe → Prywatność i ochrona →
Automatyzacja → Cribro Sift*.

Notatki leżą w `~/Library/Application Support/Cribro Sift/notes.json`,
osobno od historii. Historia to zapis tego, co powiedziałeś; notatka to
dokument, który redagujesz.

### Tekst z ekranu

Trzecia droga, którą tekst wchodzi do Cribro — obok głosu i klawiatury.
Zaznaczasz kawałek ekranu, a to, co na nim widać, staje się notatką: cudzy
PDF, slajd z prezentacji, zrzut z rozmowy, paragon.

```
   skrót (albo Plik → Tekst z ekranu…)
        ↓
   krzyżyk na ekranie                 ← systemowy; spacja łapie całe okno,
        ↓                               Escape przerywa bez śladu
   odczyt                             ← tani model GPT, jedno wywołanie
        ↓
   okno z pytaniem: dokąd i w jakiej formie
        ↓
   nowa notatka  ·  dopisanie do istniejącej  ·  pod kursor
```

**Krok jest jeden, nie dwa** — i to jest cała różnica wobec dyktowania. Mowa
niesie szum, który trzeba potem odsiać; napis na obrazku jest już zredagowany
przez tego, kto go napisał. Przepisanie go „lepiej" byłoby zmyślaniem, a nie
przesiewaniem. Dlatego model tutaj **wyłącznie czyta**:

- nie poprawia literówek ani dziwnej interpunkcji — to cudzy tekst, nie jego;
- nie tłumaczy;
- **nie odpowiada na to, co przeczytał** — pytanie na obrazku przepisuje jako
  pytanie, formularz jako formularz. Ten zakaz jest tu ważniejszy niż w sicie,
  bo na zrzucie ekranu prawie zawsze widać czyjeś pytanie albo przycisk;
- fragment nieczytelny albo ucięty krawędzią zaznaczenia zapisuje jako `[…]`,
  zamiast go zgadywać.

#### Okno z pytaniem

Dyktowanie leci od razu pod kursor, bo mówiąc, patrzysz w miejsce, w którym
tekst ma się pojawić. Zrzut robi się, patrząc na **cudze okno** — w chwili
zaznaczania nie wiadomo jeszcze, dokąd rzecz ma trafić. Dlatego pyta.

Okno staje na tym ekranie, na którym stoi kursor, i pokazuje wszystko naraz:

| Wybór | Co znaczy |
| --- | --- |
| **Dokąd** | nowa notatka · dopisanie do istniejącej (lista, najświeższa na górze) · pod kursor |
| **Forma** | tekst · obrazek · oba |

Odczyt jest w polu tekstowym, więc literówkę w nazwisku poprawia się od razu,
przed zapisem. Okno otwiera się **zanim** odczyt się skończy — inaczej po
zaznaczeniu obszaru przez dwie sekundy nie działoby się nic i wyglądałoby to
na zgubiony zrzut.

Dwa ograniczenia, oba celowe: **pod kursor idzie sam tekst** (obrazka nie da
się wkleić w cudze pole tekstowe), a **bez odczytu zostaje sama forma
„obrazek"** — bo nie ma czego wpisać.

| Klawisz | Co robi |
| --- | --- |
| ⌘⏎ | zapisuje |
| Esc | zamyka i wyrzuca zrzut |

Okno zapamiętuje ostatni wybór. Kto zawsze robi to samo, wyłącza pytanie
przełącznikiem *Pytaj, dokąd trafia* — wtedy odczyt idzie tam, gdzie poszedł
ostatnim razem.

#### Obrazek w notatce

Notatka na dysku jest Markdownem, więc zrzut leży w niej jako zwykły link:

```markdown
![zrzut ekranu](file:///Users/…/Cribro%20Sift/zrzuty/zrzut-2026-08-24-161500-ab12.png)
```

Plik zostaje na dysku **wyłącznie wtedy, gdy notatka go pokazuje** — sam
odczyt tekstu nie zostawia po sobie niczego, bo zrzut spełnił już swoje
zadanie. Obrazek nie liczy się jako tytuł notatki: na liście stoi pierwsza
linia, która coś mówi.

#### Skrót

**Ustawienia → Tekst z ekranu → Skrót.** Domyślnie **nie ma go wcale** i to
nie jest niedoróbka: macOS trzyma na zrzuty trzy fabryczne skróty (⌘⇧3, ⌘⇧4,
⌘⇧5), a czwarty wybrany za ciebie byłby albo zajęty, albo o włos od zajętego.

Klikasz *Ustaw klawisze* i naciskasz je. Skrót musi mieć modyfikator (⌘, ⌃, ⌥
albo ⇧) — bez niego zabierałby literę wszystkim polom tekstowym w systemie.
Zaraz po ustawieniu Cribro sprawdza, czy klawisze są wolne, i mówi o tym
w dymku; *Skasuj* zdejmuje je z powrotem.

W menu aplikacji (*Plik → Tekst z ekranu…*) i w pasku menu pozycja jest bez
klawiszy — celowo. Skrót z menu działa tylko wtedy, gdy z przodu jest Cribro,
a zrzut robi się z cudzego okna.

#### Model i klucz

**Ustawienia → Tekst z ekranu → Odczyt.** Domyślnie **GPT-5.6 Luna**,
najtańszy z listy: odczyt jest zadaniem odtwórczym, więc różnicę między
najtańszym a najmocniejszym widać na rachunku, a nie w wyniku. Obrazek jedzie
w rozdzielczości „high" — bez tego drobny druk (stopka, przypis, kod) wychodzi
zgadywanką.

Klucz jest ten sam co przy transkrypcji i sicie: jeśli któryś z tych kroków
chodzi już na OpenAI, wystarczy klucz wpisany tam. **Bez klucza funkcja nie
umiera** — zrzut nadal wstawisz do notatki jako obrazek, a okno powie o tym
jednym zdaniem.

Przycisk *Sprawdź* rysuje zdanie w niepokazanym oknie, robi z niego zrzut
i pyta model, co widzi. Sprawdza całą drogę naraz: klucz, model i to, czy
obrazek w ogóle dojechał.

#### Zgoda systemowa

Zaznaczanie ekranu wymaga zgody **„Nagrywanie ekranu"**. macOS zapyta o nią
przy pierwszym użyciu; jeśli odmówisz, kolejne wywołanie otworzy właściwy
panel *Ustawienia systemowe → Prywatność i ochrona → Nagrywanie ekranu*.
Zgoda dotyczy aplikacji, więc po podmianie buildu bez podpisu trzeba by ją
przyznać ponownie — dlatego wszystkie buildy są podpisywane tym samym
certyfikatem (patrz *Instalacja*).

### Widget — jedyna rzecz poza oknami

**Ustawienia → Widget.** Znaczek pływający nad wszystkimi aplikacjami —
jedyne, co Cribro pokazuje poza swoimi oknami. Przeciąga się go za sam znaczek
w dowolne miejsce ekranu i tam zostaje, także po ponownym uruchomieniu.
Domyślnie **wyłączony**; włącza go przełącznik w tej samej karcie.

Jest trzema rzeczami naraz: **stanem** (w czasie nagrywania to on pokazuje
mikrofon), **tacą** czynności robionych w biegu i **drzwiami** do notatek
odłożonych na wierzch.

Po co osobne okno, skoro jest Notatnik: bo to jest co innego. **Notatnik
otwiera się wtedy, gdy siada się do notatek. Widget jest na chwile, gdy
właśnie robi się coś zupełnie innego** — trwa rozmowa, ktoś rzuca termin,
a przełączanie okien kosztuje więcej, niż sama myśl jest warta.

Widok kompaktowy — jedno okno, trzy stany:

```
   ●              kliknięcie              ┌──────────────┐
  znaczek   ──────────────────────►       │ NA WIERZCHU  │
                                          │ Spotkanie…   │
                                          │ Pomysły…     │
                                          └──────────────┘
                                                 │ kliknięcie w notatkę
                                                 ▼   (efekt genie)
                                          ┌──────────────┐
                                          │ ‹  Spotkanie │
                                          │              │
                                          │  tekst…      │
                                          └──────────────┘
```

#### Taca — pięć rzeczy pod znaczkiem

Do niedawna były dwie pływające rzeczy: listwa nad Dockiem od czynności
i znaczek od notatek. Dwa paski od jednej aplikacji to o jeden za dużo —
zajmowały dwa miejsca na ekranie, ustawiało się je osobno i za każdym razem
trzeba było sobie przypomnieć, w którym z nich jest to, po co się sięga.
Listwy nie ma; wszystko, co robiła, robi teraz znaczek.

**Najechanie kursorem rozkłada tacę.** Kółka wychodzą spod znaczka kolumną
w dół, jedno po drugim, a ikonka notatek w bok:

```
                     ●  znaczek ────►  ▣  notatki
                     │
                     ◉  dyktuj — ⌃⌥
                     ◉  szybka notatka
                    ▁▄█  gęstość sita
                    PL·EN  język dyktowania
                     ▭  otwórz Cribro Sift
```

Kolumna idzie **w pionie**, bo znaczek stoi zwykle przy krawędzi ekranu i tam
w poziomie miejsca nie ma. Przy dolnej krawędzi wychodzi w górę, a notatki
w tę stronę, w którą jest miejsce — kierunek liczy się z położenia, tak samo
jak przy szybie z notatkami.

**Żadne kółko nie wywołuje okna aplikacji samo z siebie** — poza jednym, które
jest po to podpisane. To nie jest drobiazg: taca rozkłada się sama pod
kursorem, więc jej kółka bywają klikane przez pomyłkę, a okno wjeżdżające na
wierzch cudzej pracy jest najgorszą rzeczą, jaką pomyłka może zrobić. Gęstość
sita otwierała je do niedawna i to od niej brało się „czasem po kliknięciu
w widget otwiera się cała aplikacja".

Dwa kółka są **pokrętłami** i kliknięcie krąży po ich położeniach: gęstość sita
(zgrubne → średnie → drobne, stopień widać po trzech słupkach, opis stoi
w dymku) i język dyktowania (dwa języki → jeden → automat). Taca zostaje przy
nich rozłożona, bo wynik chce się zobaczyć — a często kliknąć jeszcze raz.
Reszta zaczyna nagrywanie albo otwiera okno, więc taca chowa się sama.

**Otwórz Cribro Sift** stoi na samym końcu kolumny, najdalej od znaczka, bo
jako jedyne prowadzi do dużego okna — przypadkowe kliknięcie ma trafić
w cokolwiek innego. Ta sama droga jest w znaczku w pasku menu; na tacy jest po
to, żeby nie trzeba było celować w pasek, gdy widget stoi na drugim końcu
ekranu.

Zejście kursorem **zwija ją po chwili zwłoki** — inaczej uciekałaby spod ręki
w drodze między kółkami. Zwijanie idzie od końca kolumny i szybciej niż
rozkładanie: zamykanie ma być mniej widowiskowe, bo dzieje się wtedy, gdy
uwaga jest już gdzie indziej.

Przesiane i Ustawienia **na tacy nie są** — to widoki w oknie, a do samego
okna prowadzi już jedno kółko; poza tym siedzą w menu aplikacji i mają klawisze
skrótu. Taca jest od czynności, przy których nie odchodzi się od tego, co się
robi.

**W czasie nagrywania znaczek jest fioletowy**, pokazuje mikrofon zamiast
sita, pulsuje dwoma pierścieniami i oddycha z głosem — to on przejmuje pałeczkę
po pigułce HUD-a. Zieleń zostaje temu, co gotowe.

Okno widgetu jest większe niż to, co widać, i leży nad cudzą pracą — dlatego
**kliknięcia przechodzą przez nie na wylot** wszędzie poza znaczkiem, tacą
i szybą. Widget łapie mysz tylko wtedy, gdy kursor jest naprawdę nad nim.

#### Dwa widoki

**Ustawienia → Widget → Widok.** Notatki na wierzchu można trzymać na dwa
sposoby — i to są dwa sposoby pracy, a nie dwa wyglądy tego samego.

| | **Kompaktowy** | **Pulpit** |
| --- | --- | --- |
| Co robi kliknięcie w znaczek | rozwija przy nim listę | wykłada notatki na pulpit |
| Gdzie są notatki | schowane, sięga się po jedną | wyłożone, widoczne bez sięgania |
| Ile okien | jedno | jedno na notatkę |
| Ile miejsca zajmuje | róg ekranu | tyle, ile im dasz |

Widok **pulpitowy** to karteczki przyklejone do ekranu: każda notatka
w osobnym okienku, każda tam, gdzie ją położysz, każda z własnym rozmiarem.
Po to się notatkę odkłada na wierzch — plan dnia ma być widoczny, a nie do
odszukania. Kartki **skalują się do ekranu**: ta sama notatka zajmuje ten sam
ułamek pulpitu na trzynastocalowym laptopie i na dwudziestosiedmiocalowym
monitorze, a przeciągnięta z jednego na drugi rośnie albo maleje w locie —
zachowując przy tym rozmiar, który jej nadałeś, zamiast wracać do domyślnego.

**Kartki są zawsze na tym ekranie, na którym stoi znaczek.** To jest cała
odpowiedź na pracę przy dwóch monitorach. Kartka nie ma własnego miejsca
w układzie wszystkich ekranów naraz — ma miejsce **na pulpicie, przy którym
się właśnie siedzi**. A o tym, przy którym się siedzi, mówi jedno: gdzie
postawiono znaczek. Znaczek jest jedyną rzeczą, którą przeciąga się świadomie
i ręcznie, więc jest jedynym wiarygodnym „tu teraz pracuję".

Wynika z tego dokładnie to, czego się po tym zdaniu spodziewasz:

- przeciągnięcie znaczka na drugi monitor **przenosi tam całą talię**, jeśli
  akurat leży na pulpicie;
- schowana talia wykłada się na tym ekranie, na którym znaczek stoi teraz,
  a nie na tym, na którym stał wczoraj;
- odłączenie monitora nie gubi kartek: wracają na ekran ze znaczkiem;
- podłączenie monitora też przestawia talię, bo razem z nim zmienia się
  obszar roboczy tego ekranu, na którym znaczek stoi.

Miejsce kartki zapamiętujemy **ułamkiem obszaru roboczego**, nie współrzędną.
Współrzędna jest prawdziwa tylko na tym monitorze, na którym powstała:
przeniesiona na laptopa wypada poza pulpit, a wracając z laptopa na duży
monitor zbija wszystkie kartki w lewy górny róg. Ułamek przenosi układ, który
ułożyłeś — plan dnia po lewej, numer telefonu pod nim — na każdy ekran, jaki
akurat jest.

**Kartki NIE pływają nad innymi oknami.** Leżą na pulpicie jak karteczki na
biurku: kliknięcie w cudze okno przykrywa je tak samo, jak przykryłoby każdą
inną kartkę. Notatka wisząca nad arkuszem, w którym ktoś właśnie pracuje,
przestaje być notatką i robi się przeszkodą — a leży ich tam po kilka naraz.
Nad wszystkim zostaje **wyłącznie znaczek**, bo jest jednym kółkiem i bo to
on te kartki zbiera; gdyby schodził pod cudze okna razem z nimi, nie byłoby
czym ich zawołać.

Kartki **rozkładają się jedna po drugiej**, rozwinięciem od górnej krawędzi,
i tak samo się składają — ostatnia wyłożona idzie pierwsza. Kilka okien
pojawiających się w jednej klatce wygląda jak usterka; rozłożone po kolei
wyglądają jak położone. Ten sam ruch i to samo tempo ma lista w widoku
kompaktowym.

Umowa jest w obu widokach ta sama i to ona je spina: **kliknięcie w znaczek
chowa wszystko**. Kartek na pulpicie nie trzeba zamykać po kolei — leżą albo
ich nie ma. Zamknięcie pojedynczej kartki (×) zdejmuje notatkę z wierzchu,
a nie chowa okno: notatka „na wierzchu", której nie widać, wracałaby przy
następnym rozłożeniu talii jak duch.

#### Rozmiar, tytuł, kolor

**Szyba rozciąga się za róg.** Uchwyt siedzi w tym rogu, który jest najdalej od
znaczka — bo tylko w tę stronę szyba ma dokąd rosnąć. Rozmiar zostaje między
uruchomieniami, a granice (208×196 do 560×760) są po to, żeby nie dało się jej
ani ściągnąć do nieczytelności, ani rozdmuchać w drugie okno aplikacji.

**Kartka na pulpicie ma swój uchwyt w prawym dolnym rogu** — pokazuje się po
najechaniu na kartkę i znika, gdy kursor z niej zejdzie. Kartka nie ma ramki,
więc nie ma też brzegu, za który dałoby się ją złapać: brzeg okna leży
w przezroczystej aureoli, poza kartką, czyli tam, gdzie nikt uchwytu nie szuka.
Granice są te same co u szyby w zamyśle (210×150 do 760×960), a rozmiar zostaje
po ponownym uruchomieniu — jedna notatka to numer telefonu, druga plan dnia
i te dwie nie potrzebują tego samego prostokąta.

W trakcie ciągnięcia okno **nie kurczy się razem z szybą**, tylko po puszczeniu
uchwytu. Kurczące się okno ucieka spod kursora: uchwyt jest w rogu, a róg jest
tym, co się właśnie cofa — po kilkudziesięciu pikselach mysz byłaby już nad
cudzą aplikacją i to ona dostawałaby resztę ruchu.

**Podwójne kliknięcie w tytuł przepisuje tytuł** — i w szybie, i na kartce, tak
samo jak na liście w Notatniku. Tytuł nie jest osobnym polem: to pierwsza
niepusta linia notatki, więc przepisanie go jest przepisaniem treści i wraca tą
samą drogą co każda inna zmiana. Enter kończy, Escape cofa.

**Kolor wybiera się kropką w pasku kartki.** Siedem, wszystkie ciemne — to nie
jest paleta do wyboru ładnego odcienia, tylko do rozróżniania kartek, a kartka
leży nad cudzą pracą i ma zostać czytelna. Kolor podmienia trzy odcienie
podłoża i krawędź; gradient, połysk i cień zostają dokładnie te same, więc
kartka wygląda identycznie, tylko w innym kolorze. Akcent zostaje zielony we
wszystkich: zieleń znaczy „zrobione", a nie „taki kolor notatki".

Kolor jedzie do chmury razem z notatką — inaczej niż „na wierzchu", które
zostaje na tym komputerze. To własność notatki, a nie tego biurka. Na liście
w widgecie widać go kropką przy tytule, bo to jedyne miejsce, w którym da się
notatkę rozpoznać, zanim się ją przeczyta.

#### Nieprzezroczyste, bo leżą na cudzej pracy

Powierzchnia notatki — i na liście, i na kartce, i w widgecie, i na pulpicie —
jest **kryjąca**. Pierwsza wersja była szkłem, tak jak reszta aplikacji.
W oknie aplikacji szkło wygląda dobrze, bo pod spodem leży własne tło. Widget
leży nad **cudzą** pracą — nad dokumentem, arkuszem, czyjąś prezentacją —
i przez notatkę przebijało się wszystko, co akurat było pod nią. Takiej notatki
nie da się przeczytać kątem oka, czyli jedynym sposobem, w jaki się ją czyta.
Szkłem został sam znaczek: on jest znaczkiem, a nie treścią.

Treść notatki idzie przez **ten sam edytor i ten sam arkusz co Notatnik**
([editor.js](src/renderer/js/editor.js), [prose.css](src/renderer/css/prose.css)).
Notatka z listą zadań wygląda na wierzchu jak lista zadań — z kwadracikami do
odhaczania — a nie jak zapis `- [ ]`, który akurat leży na dysku.

**Widget startuje pusty i pusty zostaje, dopóki sam czegoś tam nie odłożysz.**
Żadna notatka nie trafia na wierzch sama z siebie — ani nowa, ani przypięta,
ani ostatnio otwarta. Decyduje się to przy samej notatce: w Notatniku albo
w zakładce Notatki, przyciskiem **„Widoczna w widgecie"** w pasku narzędzi,
obok pinezki. Znaczek pokazuje liczbę odłożonych notatek.

**Kliknięcie w znaczek chowa wszystko naraz** — listę i otwartą kartkę,
jednym ruchem, bez przystanku na liście po drodze.

Wybór **zostaje na tym komputerze i nie jedzie do chmury**, choć notatka
jedzie. To nie jest przeoczenie: „mam to teraz przed oczami" opisuje biurko,
przy którym się siedzi, a nie treść notatki. Ta sama lista zadań bywa na
wierzchu w pracy i schowana w domu.

Trzy zachowania, które wynikają z tego, po co widget jest:

| Rzecz | Jak działa | Dlaczego |
| --- | --- | --- |
| **Fokus** | znaczek go nie bierze; kartka bierze, gdy się w nią kliknie | znaczek, który zabiera kursor z pola, w którym ktoś pisze, jest szkodnikiem |
| **Nad wszystkim** | znaczek i kartki na pulpicie — zawsze, także po przełączeniu pulpitu | notatkę odkłada się na wierzch po to, żeby była widoczna **przy** pracy w czymś innym; znikająca przy pierwszym przełączeniu okna przestawała być notatką na wierzchu |
| **Chowanie kartek** | tylko na wyraźny gest: kliknięcie w znaczek albo Escape | talia leży albo jej nie ma — i o tym, które z dwojga, decyduje człowiek, a nie to, w co akurat kliknął |
| **Lista** | zamyka się, gdy uwaga idzie gdzie indziej | lista jest menu, a menu zamykają się przy kliknięciu obok |
| **Kartka** | zostaje otwarta, także gdy pracujesz w innej aplikacji | to jest cały jej sens: dopisać zdanie bez opuszczania tego, przy czym się siedzi |

**Escape** zdejmuje po jednej warstwie, tak samo jak w Notatniku: najpierw
trwające nagranie, potem kartka, potem lista albo taca — a w widoku pulpitowym
cała talia naraz, także z klawiatury w cudzej aplikacji. Mikrofon w pasku
kartki dyktuje prosto do niej — ta sama droga co „Dyktuj" w Notatniku.

**Panel wychodzi w tę stronę, w którą jest miejsce.** Nie jedna stała strona:
widget postawiony u góry ekranu rozwija się w dół, przy dolnej krawędzi w górę,
a wciśnięty w róg, gdzie w pionie nie mieści się nic — wychodzi bokiem. Przy
dwóch stronach do wyboru wygrywa ta, która prowadzi do środka ekranu. Efekt
genie idzie razem z panelem: szyjka zawsze zostaje przy znaczku, choćby kartka
wychodziła w lewo.

Okno widgetu **zmienia rozmiar**, zamiast być cały czas duże i przezroczyste.
Pierwsza wersja trzymała stałe okno 340×500 i miała wadę nie do obejścia:
skoro znaczek siedział u jego dołu, to nie dało się go postawić wyżej niż 440
pikseli od górnej krawędzi ekranu. Teraz stała jest **kotwica** — środek
znaczka — a okno układa się wokół niej i samo decyduje, czy kartka wychodzi
w górę, czy w dół.

**Znaczek i zwinięta taca dzielą jedno okno** i to nie jest oszczędność, tylko
lekarstwo na przeskok, który było widać przy samym zbliżeniu kursora. Okno
tacy rośnie w tę stronę, w którą taca wychodzi — przy prawej krawędzi ekranu
w lewo — więc razem z jego rozmiarem zmieniało się miejsce znaczka **wewnątrz**
okna. Okno przestawia proces główny natychmiast, a nową kotwicę renderer
dostawał dopiero odpowiedzią; przez klatkę albo dwie znaczek był narysowany
sto trzydzieści osiem pikseli obok i wracał. Teraz najechanie kursorem nie
rusza okna wcale: rozłożenie tacy jest samym atrybutem w rendererze. Poza
znaczkiem okno jest przezroczyste i przepuszcza kliknięcia na wylot, więc
większy prostokąt niczego nie zasłania.

Podniesienie znaczka pod kursorem liczy się **z prostokąta, nie z `:hover`** —
z tego samego powodu, dla którego liczy się tak rozłożenie tacy. Przepuszczanie
kliknięć włącza się i wyłącza w trakcie ruchu ręki, a razem z nim okno raz po
raz przestaje dostawać zdarzenia myszy: przeglądarka gubiła wtedy stan
najechania i zaczynała przejście od nowa, w połowie poprzedniego.

Sama szyba ma **256 na 320 pikseli** — o piątą część mniej niż pierwsze
320×400. Tamta zajmowała ćwiartkę wysokości ekranu i zasłaniała okno, obok
którego miała tylko leżeć. Notatka na wierzchu to jedno zdanie do dopisania,
nie dokument; od czytania długich jest Notatnik.

#### Efekt genie

Kartka wychodzi ze znaczka tak, jak macOS wciąga okno w ikonę Docka. Nie da
się tego zapisać przejściem CSS: szerokość zmienia się **inaczej na każdej
wysokości**, a `transition` zna jedną krzywą na całą własność. Sylwetkę rysuje
więc [genie.js](src/renderer/js/genie.js) — dwadzieścia siedem poprzeczek
przeliczanych co klatkę — z trzech składników: szyjki przy znaczku, stopniowego
rozlewania i zaokrąglonego czoła strumienia.

Rachunek jest jeden na wszystkie cztery strony: liczy się wzdłuż osi głównej
(od znaczka w głąb kartki) i w poprzek, a na końcu podmienia, która z nich jest
pozioma. Test pilnuje, że obrócony kształt jest **co do joty** tym samym
kształtem, a nie osobną wersją, która zdąży się rozjechać.

Ta geometria jest czystą funkcją, więc sprawdza ją test, a nie oko:

```bash
node scripts/genie-test.js
```

Pilnuje między innymi tego, że na końcu ruchu zostaje **czysty prostokąt**,
a nie kartka z ogonkiem, że szerokość **tylko rośnie** (cofnięcie widać jako
drgnięcie) i że szyjka trzyma się znaczka także wtedy, gdy znaczek stoi
przy samej krawędzi ekranu.

### Ikona w Docku

Aplikacja pokazuje się w Docku, kiedy działa — to zwykłe zachowanie macOS.
Żeby została tam **na stałe**: prawy przycisk na ikonie w Docku →
*Opcje* → *Zatrzymaj w Docku*.

Jeśli wolisz mieć Cribro wyłącznie w pasku menu, wyłącz *Ustawienia → Dock →
Ikona w Docku*. Wtedy aplikacja znika też z ⌘Tab.

### Menu aplikacji

Wszystko, co otwiera okno, mieszka w głównym menu — i tam ma klawisze:

| Menu | Pozycje |
| --- | --- |
| **Cribro Sift** | O programie · Ustawienia ⌘, · Ukryj · Zakończ |
| **Plik** | Nowa notatka ⌘N · Szybka notatka ⌘⇧N · Notatnik ⌘⇧O · Dyktuj ⌘D |
| **Edycja** | cofnij, powtórz, wytnij, kopiuj, wklej, wklej jako zwykły tekst · Sprawdzaj pisownię |
| **Widok** | Start ⌘1 · Przesiane ⌘2 · Notatki ⌘3 · Sito ⌘4 · Ziarna ⌘5 · Ustawienia ⌘6 |
| **Okno** | zminimalizuj, powiększ, Otwórz Cribro Sift |

„Nowa notatka" trafia tam, gdzie właśnie patrzysz: przy otwartym oknie głównym
zakłada notatkę w zakładce Notatki, w każdym innym razie w Notatniku.

To samo, czego najczęściej potrzeba bez okna, siedzi dalej w **pasku menu**:
Przesiane, Notatnik, Szybka notatka, Ustawienia, gęstość sita, język
dyktowania i automatyczne wklejanie.

### Historia

Zakładka **Przesiane** trzyma wszystkie dyktowania. Przy każdym wpisie:
przycisk **„Co odpadło"** pokazuje surową transkrypcję z przekreślonym szumem,
**„Przesiej ponownie"** przepuszcza ten sam zapis przez inną gęstość sita,
a **„Przypnij"** chroni wpis przed czyszczeniem historii.

Historia leży w `~/Library/Application Support/Cribro Sift/history.json`.
Nagranie audio **nie jest zapisywane** — ginie zaraz po transkrypcji.

---

## Konto i notatki w chmurze

Notatki mogą mieć kopię na **własnym projekcie Supabase** — po to, żeby ta sama
notatka była na dwóch komputerach. Domyślnie jest to **wyłączone** i wtedy nic
nie wychodzi z dysku.

**Historia dyktowania nie jedzie tam nigdy.** To nie jest przeoczenie: historia
trzyma surowe transkrypty razem z nazwą aplikacji, do której mówiłeś. Nie ma jej
w schemacie bazy i nie ma dokąd jej wysłać.

### Jak to uruchomić

1. Załóż projekt na [supabase.com](https://supabase.com) (darmowy poziom wystarcza).
2. **SQL Editor → New query** → wklej całość `supabase/schema.sql` → **Run**.
   Skrypt jest idempotentny, można go puścić drugi raz.
3. **Project Settings → API** → skopiuj *Project URL* i klucz *anon public*.
4. W Cribro: **Ustawienia → Konto i notatki w chmurze** → włącz przełącznik,
   wklej adres i klucz, załóż konto albo się zaloguj.

Jeśli w projekcie zostawisz domyślne potwierdzanie adresu e-mail, po założeniu
konta trzeba kliknąć link z poczty i dopiero wtedy zalogować się w aplikacji.

### Logowanie przez Google

Zamiast adresu i hasła można wejść kontem Google — **Ustawienia → Konto
i notatki w chmurze → Zaloguj przez Google**. To jest to samo konto: jeśli
adres w Google jest ten sam co przy rejestracji, notatki są te same.

Trzy rzeczy do ustawienia raz, wszystkie poza aplikacją:

1. **Google Cloud Console** → *APIs & Services* → *Credentials* → **Create
   credentials → OAuth client ID → Web application**. W polu *Authorized
   redirect URIs* wpisz adres SWOJEGO projektu Supabase:
   `https://<twój-projekt>.supabase.co/auth/v1/callback`.
   Zapisz *Client ID* i *Client secret*.
2. **Panel Supabase → Authentication → Providers → Google** → włącz i wklej
   oba. To Supabase rozmawia z Google, nie aplikacja — dlatego adres powrotny
   po stronie Google jest adresem Supabase, a nie Twojego komputera.
3. **Panel Supabase → Authentication → URL Configuration → Redirect URLs** →
   dopisz adresy, na które Supabase odeśle aplikację:

   ```
   http://127.0.0.1:53682/auth/callback
   http://127.0.0.1:53683/auth/callback
   http://127.0.0.1:53684/auth/callback
   ```

   Można zamiast tego jedną linijkę `http://127.0.0.1:*/auth/callback`.
   Te same adresy pokazuje karta konta w Ustawieniach, z przyciskiem
   „Kopiuj adresy" — nie trzeba ich przepisywać stąd.

Dalej jest już jedno kliknięcie: aplikacja otwiera **systemową przeglądarkę**,
Google pyta o zgodę, przeglądarka wraca na `127.0.0.1` z kodem, a aplikacja
wymienia go na sesję.

**Dlaczego w przeglądarce, a nie w oknie aplikacji.** Okno wbudowane
pokazywałoby pole na hasło do Google, które samo narysowało — i nie dałoby się
sprawdzić, czy to naprawdę Google. W przeglądarce widać kłódkę i adres,
a przy okazji zwykle jest się tam już zalogowanym. Tak każe robić RFC 8252
(*OAuth 2.0 for Native Apps*) i tak robi każda porządna aplikacja desktopowa.

**Dlaczego PKCE.** Aplikacji desktopowej nie da się dać tajemnicy — cokolwiek
zaszyte w bundlu da się z niego wyjąć. Zamiast tego aplikacja losuje sekret na
jedno logowanie, wysyła jego skrót, a przy odbiorze kodu pokazuje oryginał. Kod
przechwycony po drodze jest wtedy bezużyteczny. Przy okazji to jedyny wariant,
który tu w ogóle działa: bez PKCE token wraca w kotwicy adresu
(`#access_token=…`), a kotwica nigdy nie dochodzi do serwera — pętla zwrotna
nie miałaby czego odebrać.

**Dlaczego trzy porty, a nie własny schemat `cribro://`.** Schemat wymaga wpisu
w `Info.plist` i rejestracji w LaunchServices, a przy uruchomieniu z `npm run
dev` przejmuje go binarka Electrona z `node_modules`. Pętla zwrotna działa tak
samo w obu przypadkach. Porty są trzy, bo jeden zajęty nie może znaczyć „nie da
się zalogować" — aplikacja bierze pierwszy wolny.

**Logowanie przez Apple** wejdzie tą samą drogą, gdy będzie konto Apple
Developer: `signInWithProvider` w [oauth.js](src/main/oauth.js) przyjmuje
dostawcę jako parametr, więc po stronie aplikacji zmieni się jeden napis
i jeden przycisk. Reszta to konfiguracja w panelu Apple i w Supabase.

### O które klucze chodzi, a o które nie

| Klucz | Gdzie | Po co |
| --- | --- | --- |
| **anon public** | w aplikacji, w `settings.json` | jedzie w każdym żądaniu; sam z siebie nie daje dostępu do niczego — o tym, co widać, decyduje RLS na podstawie tego, kto jest zalogowany |
| **service_role** | **nigdzie** | omija RLS. Kto go ma, ma notatki wszystkich ludzi. W aplikacji desktopowej nie ma czego szukać |
| token dostępu | `supabase-session.bin`, szyfrowany pękiem kluczy | wygasa po godzinie i odświeża się sam |

Innych tokenów nie trzeba. Token dostępu do **panelu** Supabase (`sbp_…`) jest
potrzebny wyłącznie wtedy, gdy zamiast wklejać SQL wolisz `supabase db push`
z wiersza poleceń — aplikacja go nie widzi i nie chce.

### Co siedzi w bazie

```
auth.users        konta — obsługuje je Supabase, nie ruszamy
public.profiles   1:1 z kontem: nazwa wyświetlana, czasy
public.notes      notatki: local_id, text, pinned, updated_at,
                  deleted_at (nagrobek), synced_at (zegar serwera)
```

Każda tabela ma **RLS** i cztery osobne polityki (czytam / dopisuję / zmieniam /
kasuję), wszystkie na `auth.uid() = user_id`. Bez zalogowania nie widać ani
wiersza — także z prawidłowym kluczem anon.

### Sprawdzenie, że RLS naprawdę działa

„Włączyłem RLS" i „RLS działa" to dwa różne zdania. Pierwsze widać w panelu,
drugie sprawdza się tylko jednym sposobem — próbując:

```bash
node scripts/cloud-check.js
```

Skrypt bierze adres i klucz z ustawień aplikacji, pyta o jedno albo dwa konta
(hasła nie widać) i **próbuje zrobić rzeczy, których robić nie wolno**:

| Próba | Ma się skończyć |
| --- | --- |
| czytanie notatek z samym kluczem anon, bez logowania | zero wierszy |
| czytanie profili bez logowania | zero wierszy |
| dopisanie notatki bez logowania | odrzucone |
| konto A wstawia wiersz z cudzym `user_id` | odrzucone |
| konto A woła `purge_deleted_notes()` przez RPC | odrzucone |
| konto B czyta notatkę konta A | zero wierszy |
| konto B zmienia notatkę konta A | zero zmienionych |
| konto B kasuje notatkę konta A | zero skasowanych |

Po sobie sprząta — notatka kontrolna jest kasowana na koniec. Drugie konto jest
opcjonalne, ale bez niego nie da się sprawdzić tego, o co w RLS chodzi
najbardziej; skrypt powie wtedy wprost, czego nie sprawdził.

Bez podawania haseł w wierszu poleceń (i bez śladu w historii powłoki) można
też tak:

```bash
CRIBRO_A_EMAIL=… CRIBRO_A_PASSWORD=… CRIBRO_B_EMAIL=… CRIBRO_B_PASSWORD=… \
  node scripts/cloud-check.js
```

### Jak działa uzgadnianie

Zasada jest jedna: **dysk jest źródłem prawdy, chmura jest kopią**. Notatka
powstaje lokalnie i dostaje lokalne id, zanim w ogóle zobaczy serwer — Cribro
ma działać bez sieci i bez konta tak samo dobrze jak z nimi.

- **Kto wygrywa spór.** Nowszy `updated_at`, czyli czas z urządzenia. Czas
  serwera mówi tylko o tym, kiedy przyszło żądanie, nie o tym, kiedy ktoś pisał.
- **Kasowanie zostawia nagrobek.** Bez niego notatka skasowana na laptopie
  wracałaby z drugiego komputera, bo „skasowana" i „jeszcze niewysłana"
  wyglądają z tamtej strony identycznie. Treść znika od razu, nagrobek żyje
  trzydzieści dni i potem jest sprzątany.
- **Kolejność w jednym przebiegu:** najpierw pobranie, potem wysyłka. Odwrotnie
  własna wysyłka podniosłaby kursor ponad zmiany, których jeszcze nie
  widzieliśmy, i te zmiany przepadłyby po cichu.
- **Kursorem jest `synced_at` z serwera**, nie z urządzenia. Komputer
  z przestawionym zegarem wpisałby czas z przeszłości i jego zmiany nie
  przeszłyby przez kursor drugiego — najgorszy rodzaj błędu synchronizacji,
  bo niewidoczny.
- **Kiedy.** Po każdej zmianie notatki (z pięciosekundową zwłoką — pisanie to
  seria zmian) i co pięć minut. Przełącznik *Synchronizuj w tle* to wyłącza
  i zostaje przycisk *Synchronizuj teraz*.

Notatki, które powstały **zanim konto istniało**, trafiają do konta, na które
się zalogujesz. Tak samo przy przesiadce na inne konto: kursor liczy się od zera,
a to, co leży na tym komputerze, jedzie tam, gdzie właśnie wszedłeś.

To wszystko jest sprawdzane bez sieci i bez konta — `node scripts/sync-test.js`
stawia dwa „komputery" nad jedną atrapą serwera i pilnuje, żeby nikomu nie
zginęła praca.

### Czego chmura nie robi

Nie ma synchronizacji na żywo (żadnych WebSocketów — notatka otwarta na dwóch
ekranach naraz uzgodni się przy najbliższym przebiegu, nie znak po znaku),
nie ma załączników i nie ma współdzielenia notatek z innym kontem.

---

## Gdzie co leży

| Co | Gdzie |
| --- | --- |
| Kod źródłowy | `~/MyApps - local files/cribro-sift/` |
| Build pośredni | `~/CribroSift-build/` |
| Zainstalowana aplikacja | `/Applications/Cribro Sift.app` |
| Ustawienia i klucze | `~/Library/Application Support/Cribro Sift/settings.json` |
| Historia dyktowań (razem z tym, które polecenie ruszyło) | `~/Library/Application Support/Cribro Sift/history.json` |
| Notatki (razem z flagą „na wierzchu") | `~/Library/Application Support/Cribro Sift/notes.json` |
| Zrzuty wstawione do notatek | `~/Library/Application Support/Cribro Sift/zrzuty/` |
| Zakładka synchronizacji | `~/Library/Application Support/Cribro Sift/cloud.json` |
| Sesja Supabase (szyfrowana) | `~/Library/Application Support/Cribro Sift/supabase-session.bin` |
| Token Notion i zakładka stron | `settings.json`, gałąź `notion` — nie jedzie do chmury |
| Schemat bazy do wklejenia | `supabase/schema.sql` w katalogu projektu |
| Certyfikat do podpisu | `~/Library/Keychains/cribro-sign.keychain-db` |

Projekt celowo **nie leży w iCloud Drive**. Dwa powody:

1. `codesign` odmawia pracy na plikach z atrybutem `com.apple.FinderInfo`,
   który iCloud dokleja i przywraca po każdym usunięciu.
2. iCloud potrafi zwolnić miejsce, zamieniając pliki w puste zaczepy pobierane
   na żądanie. Przy `node_modules` z tysiącami plików kończy się to błędami
   budowania, których nie da się sensownie zdiagnozować.

## Uruchamianie bez pakowania (do dłubania w kodzie)

```bash
npm start
```

> **Z terminala VS Code:** środowisko rozszerzeń eksportuje
> `ELECTRON_RUN_AS_NODE=1`, przez co Electron startuje jako zwykły Node
> i cicho ginie. Wtedy: `env -u ELECTRON_RUN_AS_NODE npm start`.

W trybie deweloperskim macOS pyta o zgody dla „Electron", nie dla „Cribro Sift" —
to osobne wpisy w Ustawieniach systemowych.

---

## Architektura

```
src/main/
  main.js        okna, menu aplikacji i paska, IPC, orkiestracja ścieżki
  providers.js   katalog dostawców i modeli, wyszukiwanie klucza
  stt.js         KROK 1 — transkrypcja (Gemini, OpenAI, atrapa)
  commands.js    KROK 1½ — polecenia: rozpoznanie lokalne, katalog dla sita
  sieve.js       KROK 2 — sito: prompt, gęstości oczek, ziarna, polecenia
  shot.js        tekst z ekranu: zaznaczenie obszaru, odczyt, składanie notatki
  hotkeys.js     dwa backendy skrótu: uiohook oraz globalShortcut
  shortcuts.js   wykrywanie konfliktów skrótu z systemem i aplikacjami
  languages.js   tryby językowe: jeden język, para języków, automat
  paste.js       schowek + symulacja ⌘V przez System Events
  share.js       Notatki Apple przez AppleScript, eksport do Markdown
  pdf.js         notatka jako PDF: jasna kartka z tokenów motywu
  notion.js      notatka jako strona w Notion: Markdown → bloki, na samym fetch
  store.js       ustawienia i historia w JSON, migracja, statystyki
  supabase.js    konta i baza: GoTrue + PostgREST na samym fetch, sesja
  oauth.js       logowanie przez Google: przeglądarka, PKCE, pętla zwrotna
  sync.js        uzgadnianie notatek: nagrobki, kursor, kto wygrywa spór
src/renderer/
  index.html     Start · Przesiane · Notatki · Sito · Ziarna · Polecenia · Ustawienia
  hud.html       pierścień widoczny podczas dyktowania
  notes.html     Notatnik — osobne okno; z „?note=id" jedna notatka bez listy
  quick.html     szybka notatka — małe okno z jednym polem
  shot.html      tekst z ekranu — okno z pytaniem: dokąd i w jakiej formie
  widget.html    pływający znaczek: taca czynności i notatki „na wierzchu"
  sticky.html    jedna notatka jako kartka na pulpicie (widok „pulpit")
  js/onboarding.js  przewodnik: osiem slajdów, sceny SVG, pierwsze uruchomienie
  js/hud.js      nagrywanie PCM → WAV 16 kHz mono
  js/widget.js   widget: cztery stany, taca, przeciąganie, kartka na wierzchu
  js/sticky.js   kartka na pulpicie: treść, rozwijanie, skala ekranu, kolor
  js/genie.js    sylwetka efektu genie — czysta geometria, bez DOM-u
  js/diff.js     porównanie surowego z przesianym (LCS na słowach)
  js/editor.js   edytor notatki: contenteditable, własne operacje na blokach
  js/notes-core.js   tytuł, zajawka, kolejność — wspólne dla obu widoków
  js/notes-view.js   zakładka Notatki w oknie głównym
  js/shot.js     okno zrzutu: podgląd, poprawki w odczycie, dwa wybory
  js/theme.js    kolory z tokenów dla tego, co rysowane na canvasie
  js/i18n.js     tłumaczenie interfejsu (t() i przejście po drzewie)
  css/prose.css  wygląd sformatowanego tekstu notatki, wspólny dla okien
  css/onboarding.css  przewodnik: układ slajdów i ruch ośmiu scen
src/shared/
  strings.js     słownik pl → en, wspólny dla obu procesów
  richtext.js    Markdown ↔ HTML — jedno miejsce dla obu kierunków
  js/constellation.js  tło: dryfujące punkty i linie bliskości, 30 kl./s
  css/tokens.css kopia tokenów motywu — jedyne miejsce z surowym kolorem
supabase/
  schema.sql     tabele, RLS, wyzwalacze — do wklejenia w SQL Editor
design/themes/   pakiet motywu (źródło prawdy, patrz niżej)
landing/         strona produktu
scripts/         testy, zrzuty ekranu, ikona
  smoke.js          żądania do dostawców, bez kluczy i bez sieci
  hotkey-test.js    maszyna stanów skrótu: trzymanie, stuknięcia, Escape
  notes-test.js     kształt notatki przy dopisywaniu z dyktowania
  editor-test.js    Markdown ↔ sformatowany tekst, tam i z powrotem
                    (nagłówki, kreska, nagłówek składany)
  toolbar-test.js   paski narzędzi, ikony i przewodnik w szablonach: rysunek
                    bez fill (czarna plama), odwołanie do nieistniejącego
                    symbolu, grupy paska notatki, menu bez przycisku,
                    slajd bez rysunku
  sync-test.js      dwa „komputery" nad atrapą serwera: spór, kasowanie, kursor
  genie-test.js     sylwetka animacji widgetu: prostokąt na końcu, brak drgnięć
  oauth-test.js     logowanie przez Google bez Google: adres, kod, PKCE, odmowa
  commands-test.js  co rusza polecenie, a co nie: krawędź, granica zdania,
                    furtka, znacznik od sita, migracja zestawu startowego
  shot-test.js      tekst z ekranu: adres obrazka ze spacjami, kontrakt odczytu,
                    brak klucza, anulowane zaznaczenie, obrazek w notatce
  cloud-check.js    RLS na żywym projekcie: próby zrobienia tego, czego nie wolno
  make-identity.sh  certyfikat o stałym odcisku — raz na Maca
  sign.sh           podpis buildu tym certyfikatem
  install.sh        przeniesienie do /Applications + LaunchServices i Spotlight
```

Dlaczego WAV, a nie WebM z `MediaRecorder`: Gemini przyjmuje WAV, MP3, OGG
i FLAC — ale nie WebM. WAV 16 kHz mono przechodzi u wszystkich dostawców bez
konwersji, a kilkanaście sekund mowy waży ułamek megabajta.

HUD ma `focusable: false` i pokazuje się przez `showInactive()`. Gdyby przejął
fokus, symulowane ⌘V trafiłoby w niego zamiast w aplikację, do której mówisz.

---

## Motyw

Aplikacja ma **jeden** motyw: *Nocturne Green*. Nie ma przełącznika jasny/ciemny
i nie ma drugiego zestawu kolorów — jest jeden ciemny grunt, jeden akcent
i trzy kroje o sztywno przypisanych rolach.

Pakiet motywu leży w `design/themes/`:

| Plik | Co to jest |
| --- | --- |
| `README.md` | kierunek i zasady |
| `tokens.css` | tokeny — jedyne miejsce, w którym wolno napisać surowy kolor, krój albo promień |
| `components.md` | przepisy na przycisk, kartę, pole, odznakę, listę, modal |
| `constellation.js` | tło: dryfujące punkty łączone liniami bliskości |
| `tailwind.config.snippet.js` | te same tokeny dla Tailwinda *(ten projekt go nie używa)* |
| `CLAUDE-CODE-PROMPT.md` | instrukcja wdrożeniowa, od której zaczęła się ta migracja |

`src/renderer/css/tokens.css` to **kopia 1:1** `design/themes/tokens.css` —
motyw aktualizuje się przez podmianę tego jednego pliku.

Zasady, które trzymają to w kupie:

1. **Jeden akcent.** Mięta jest jedynym nasyconym kolorem. Bursztyn i czerwień
   są stanem, nie ozdobą — dlatego wyprowadzamy je z `--warn` i `--danger`
   przez `color-mix()`, zamiast dopisywać nowe odcienie.
2. **Akcent nie zalewa dużych powierzchni.** Jedyny wyjątek to przycisk „Dyktuj"
   — jedna główna akcja na ekran.
3. **Poświata jest funkcją.** Świeci to, co żyje albo jest wybrane: nagrywanie,
   przypięty wpis, wybrana gęstość sita. Nic poza tym.
4. **Krawędź przed cieniem.** Każda powierzchnia ma włos 1px; cień daje głębię,
   nie granicę.
5. **Kafel jest szybą.** Każda powierzchnia w oknie — karta, kafel statystyk,
   wpis historii, panel notatek, taca widgetu, HUD, menu — dostaje jeden przepis
   z tokenów `--glass-*`: rozmycie z podbitym nasyceniem (`saturate(207%)`),
   skośną warstwę światła na powierzchni, jasną krawędź u góry i niski,
   miękki cień. Wypukłość robią dwie warstwy położone wewnątrz kształtu:
   światło zbierające się tuż pod górną krawędzią i cień gasnący przy dolnej —
   bez nich tafla jest płaska, bo samo rozmycie nie robi jeszcze szkła.
   Tło pod spodem ma być widać rozmyte, a nie zasłonięte — dlatego szkło stoi
   na `--surface-2`, nie na płycie. Zmiana wyglądu szkła w całej aplikacji
   to zmiana czterech tokenów.

   Okno szybkiej notatki jest wyjątkiem w jedną stronę: ma naprawdę rozmywać
   to, co za nim, więc stoi na rzadszym `--glass-thin`, a samo rozmycie robi
   system (`vibrancy: "under-window"`). Gęstsze tło zakrywało to rozmycie
   i zostawała matowa płytka zamiast szkła.
6. **Role krojów są sztywne.** Serif tylko w nagłówkach, mono w wersalikowych
   etykietach i liczbach, sans w całej reszcie.

Rysunki na canvasie (sito w Ustawieniach, pierścień HUD-a, ikony paska menu)
też biorą kolor z tokenów — przez `js/theme.js`, a w przypadku ikon paska menu
przez odczyt `design/themes/tokens.css` w trakcie generowania. Inaczej akcent
istniałby w dwóch miejscach naraz i przy pierwszej zmianie motywu jedno z nich
zostałoby w tyle.

Podgląd bez budowania aplikacji:

```bash
npm run mockup    # dist/app.html — ten sam CSS, atrapa mostu zamiast Electrona
```

---

## Płynność

Aplikacja potrafiła się zacinać — na ułamek sekundy, nieregularnie, najczęściej
przy pisaniu w notatce i przy składaniu listy. Powód nie leżał w żadnym z tych
miejsc z osobna, tylko w tym, że **nad animowanym tłem leży szkło**:

```
   konstelacja rysuje klatkę
        ↓
   zmieniło się to, co JEST POD szybami
        ↓
   backdrop-filter: blur(46px) przelicza się od nowa
        ↓            (pas boczny, panele, menu, pasek notatki…)
   … sześćdziesiąt razy na sekundę
```

Jedna klatka tła to nie było „narysuj sto kresek", tylko „narysuj sto kresek
i rozmyj pół ekranu jeszcze raz". Dopóki nic innego się nie działo, budżet
klatki wystarczał. Gdy w tę samą klatkę trafiało coś jeszcze — przebudowa
listy, składanie panelu — nie wystarczał i to było widać.

Zmienione jest sześć rzeczy. Wszystkie o tempo, żadna o wygląd:

| Co | Było | Jest |
| --- | --- | --- |
| Tempo tła | 60 klatek na sekundę | 30 — punkty dryfują 0,16 piksela na klatkę, różnicy nie widać |
| Szukanie sąsiadów | każdy punkt z każdym (~7000 par) | siatka komórek: ~8 porównań na punkt |
| Odległości | pierwiastek dla każdej pary | kwadraty; pierwiastek tylko dla linii, które powstaną |
| Rysowanie | osobne `stroke()` na każdą linię | pięć ścieżek pogrupowanych kryciem, kropki w jednej |
| Rozdzielczość tła | pełna gęstość Retiny (×2) | ×1,5 — kropki i kreski mają krycie poniżej 0,2 |
| Kiedy w ogóle | zawsze, dopóki okno jest widoczne | staje, gdy okno straci aktywność i na czas składania listy |

Postój na czas przejść jest tu najważniejszy i najprostszy: dwie kosztowne
rzeczy w jednej klatce widać jako szarpnięcie, a na te niecałą sekundę
i tak nikt na tło nie patrzy (`pause()` / `resume()` w `js/constellation.js`).

Osobno naprawione są dwie rzeczy, które **wyglądały** jak zacięcie, choć nią
nie były:

**Kafle notatek zapalały się z opóźnieniem.** Rozkładanie listy jest schodkowe:
kafel ma opóźnienie proporcjonalne do swojego numeru. Opóźnienie było jednak
wpisane jednym `transition-delay`, więc obejmowało **wszystkie** własności —
także tło i obwódkę. Najechanie na dwudziesty kafel zapalało go dopiero po pół
sekundy. Teraz ruch ma swoją kolej, a tło i obwódka zero; sama kolej urywa się
przy dwunastym kaflu, bo dalej i tak nie widać, który wyszedł pierwszy.

**HUD produkował śmieci w trakcie nagrywania.** Pierścień czytał próbki dźwięku
do świeżej tablicy w każdej klatce — kilobajt sześćdziesiąt razy na sekundę.
Odśmiecacz sprząta to wtedy, kiedy jemu wygodnie, czasem w środku rysowania.
Bufor jest teraz jeden na całe nagranie.

Kafle listy dostały też `contain: layout paint style`: przebudowa jednego nie
każe przeglądarce przeliczać całej listy. Przy stu notatkach to różnica
widoczna gołym okiem.

## Kiedy coś nie działa

Pasek błędu w oknie mówi, **na którym etapie** padło: transkrypcja, sito czy
dostarczenie. Zostaje na ekranie, dopóki go nie zamkniesz.

Jeden przypadek celowo nie wygląda na błąd: **puste nagranie**. Cisza, szum
albo muśnięcie klawiszy kończą się smutną miną 😔 i zdaniem *„Nie mogę pomóc,
bo nic nie usłyszałem"* — w pigułce HUD-a, przez niecałe trzy sekundy, i tym
samym zdaniem w oknie, jeśli akurat jest otwarte. Nic się nie zepsuło:
mikrofon działał, sito działało, nie było czego przesiać. Stan wraca do
„gotowe" **od razu**, więc powtórzenie dyktowania nie czeka na koniec
komunikatu.

| Objaw | Przyczyna |
| --- | --- |
| „Klucz API odrzucony (401)" | zły albo ucięty klucz |
| „Nie ma takiego modelu (404)" | model niedostępny na tym koncie — wybierz inny z listy |
| „Nie mogę pomóc, bo nic nie usłyszałem" | mikrofon wyciszony, mówiłeś za cicho albo trzymałeś klawisze krócej niż pół sekundy |
| Skrót nie reaguje | brak zgody Dostępność — użyj przycisku „Dyktuj" albo włącz zgodę |
| Tekst w schowku, ale nie wkleja się | brak zgody Dostępność |
| Zgoda jest włączona, a aplikacja twierdzi, że jej nie ma | wpis w Ustawieniach pamięta poprzedni podpis — patrz niżej |

### Martwy wpis w Dostępności

Jeśli Cribro jest na liście, przełącznik jest włączony, a aplikacja dalej
pokazuje pasek „potrzebuję zgody” — wpis pamięta poprzedni podpis aplikacji.
Przełączanie tam i z powrotem nie pomoże, bo system porównuje podpis, nie nazwę.

```bash
codesign -d -r- /Applications/"Cribro Sift.app" | grep designated
```

Jeśli w odpowiedzi jest samo `cdhash H"…"`, to aplikacja została podpisana
ad-hoc i każda przebudowa unieważnia zgodę. Naprawa raz na zawsze:

```bash
npm run identity                              # certyfikat o stałym odcisku
npm run app                                   # przebuduj i podpisz nim
tccutil reset Accessibility com.cribro.sift   # skasuj martwy wpis
```

Potem uruchom aplikację i przyznaj zgodę jeszcze raz — ta jedna zostanie
już na dobre. Okno nie wymaga restartu: sprawdza zgodę co dwie sekundy
i samo przepina silnik skrótu, gdy tylko zgoda się pojawi.

```bash
npm test          # dostawcy, skrót, notatki, edytor, synchronizacja, animacja
```

---

## Czego jeszcze nie ma

- notaryzacji — aplikacja działa tylko na tym Macu
- strumieniowania odpowiedzi sita
- lokalnego `whisper.cpp` jako dostawcy offline
- wybierania klawiszy skrótu myszką
- globalnego skrótu do szybkiej notatki — z menu ⌘⇧N działa, spoza Cribro nie
- synchronizacji notatek na żywo — uzgadnianie chodzi przebiegami, nie znak po znaku
- logowania przez Apple — Google i adres z hasłem działają
- zagnieżdżonych szuflad — szuflada jest jedna i płaska, bez drzewa
- czytania z Notion — notatka jedzie tam w jedną stronę
- eksportu całej szuflady naraz — PDF i Notion biorą jedną notatkę
- zrzutów w chmurze i w Notion — obrazek zostaje na tym dysku, do którego
  prowadzi jego adres; synchronizacja notatek wozi sam tekst notatki
- odczytu z pliku graficznego — wchodzi się przez zaznaczenie ekranu,
  a nie przez przeciągnięcie obrazka na okno
