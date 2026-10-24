# Zápasy zo SZH (automatické sťahovanie)

Tento malý program každú hodinu (a počas zápasov každú minútu) prečíta verejné stránky
slovakhandball.sk a zapíše zápasy, výsledky, podrobnosti a tabuľky našich piatich kategórií do databázy
aplikácie (Firebase, kolekcie `matches` a `standings`). Appka potom len číta z databázy, ako doteraz.
Beží zadarmo na GitHub Actions, nie v telefóne.

## Ako to rozbehnúť (jednorazovo, asi 15 minút)

### 1. Kľúč do databázy
1. Firebase konzola → projekt **legends-sala** → ozubené koleso → **Project settings** → záložka **Service accounts**.
2. **Generate new private key** → **Generate key**. Stiahne sa súbor `.json`. Je to heslo do celej databázy:
   nikomu ho neposielajte a po kroku 3 ho zmažte.

### 2. Repozitár na GitHube
1. Na github.com sa prihláste (alebo si urobte účet) a vpravo hore **+ → New repository**.
2. Názov napr. `legends-sync`, **Public** (verejný repozitár má neobmedzené bezplatné minúty; v súkromnom je len
   2 000 minút mesačne a sledovanie zápasov ich minie viac). V repozitári nie sú žiadne heslá, len tento program.
3. **Create repository** → odkaz **uploading an existing file**.
4. Z priečinka `szh-sync` (celý jeho obsah, aj skrytý priečinok `.github`) všetko potiahnite do okna prehliadača
   a dole stlačte **Commit changes**.
   - Ak sa priečinok `.github` neprenesie: **Add file → Create new file**, do mena napíšte
     `.github/workflows/szh-sync.yml` a vložte obsah súboru `szh-sync.yml`.

### 3. Vloženie kľúča
1. V repozitári **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `FIREBASE_SERVICE_ACCOUNT`, Secret: celý obsah stiahnutého súboru `.json`. **Add secret**.
3. Súbor `.json` zo svojho počítača zmažte.

### 4. Skúška bez zápisu
1. Záložka **Actions** → ak sa pýta, povoľte workflows → vľavo **Zápasy zo SZH** → **Run workflow**.
2. Nechajte `mode = auto` a **dry_run zaškrtnuté** → **Run workflow**.
3. Po minúte-dvoch otvorte beh a pozrite výpis kroku „Sťahovanie“. Má byť napríklad:
   `Zápasy: 100 nových, ...` a `would write match ...` (nič sa nezapísalo). Prvý raz prečíta asi 30 MB stránok.

### 5. Ostrý beh
1. **Run workflow** ešte raz, tentoraz **dry_run odškrtnite**. Zapíše sa všetko do databázy.
2. Od teraz beží samo každú hodinu (`7 * * * *`, v zápasový deň a pri zápasoch naživo ho vidno častejšie).
3. Ak vo výpise vidíte `Upozornenie: ... zápasov v databáze zväz už nelistuje`, ide o staré zápasy z predošlého
   importu, ktoré zväz medzitým zrušil alebo zlúčil. Nezmažú sa samy; v správcovi ich môžete zmazať.

## Ako to funguje

- **Celý zápasový deň v jednom behu.** GitHub spúšťa časované behy nespoľahlivo (v sobotu 24. 10. nebol medzi 7:41 a 12:49
  žiadny), preto sa na ne nedá spoliehať minútu po minúte. V zápasový deň preto prvý beh, ktorý sa spustí, zostane
  celý deň: robí hlavné sťahovanie, sleduje zápasy a čaká na ďalšie. Skončí, keď v ten deň nie je žiadny zápas
  a keď po 5,5 hodine deň stále trvá, spustí ďalší beh sám. Časovače sú dva za hodinu (`:07` a `:37`), aby sa
  zvýšila šanca, že aspoň jeden z nich GitHub nevynechá.
- **Hlavné sťahovanie** (v behu každých 45 minút, v zápasový deň a deň po ňom, inak každú 6. hodinu): z každej súťaže
  stiahne jednu stránku (všetky zápasy a tabuľka, 1 až 3 MB), zapíše, čo sa zmenilo, a pri odohratých zápasoch si prečíta
  ich vlastnú stránku (súpisky, góly, tresty, rozhodcovia, priebeh).
- **Naživo**: od 10 minút pred výkopom číta stránku zápasu každú minútu, zapisuje skóre a priebeh (appka ukáže
  červené **PREBIEHA** a v detaile zápasu **Priebeh zápasu**: každý gól, vylúčenie a kartu s časom).
- **Kedy zápas skončil.** Federácia nemá stav „prebieha“: zápas je „Upcoming“ a po pár minútach „Finished“,
  aj keď sa ešte hrá, a nehrané zápasy môžu byť „Finished“ bez výsledku. Preto sa stav nepoužíva. Zápas
  prebieha, keď má zapísaný výsledok alebo udalosti a od výkopu ubehlo menej ako 100 minút. Skončil, keď sa
  začal druhý polčas, ubehlo aspoň 30 minút a 6 minút sa nič nestalo (prestávka medzi polčasmi ho neukončí),
  alebo keď ubehlo 100 minút.
- Zväzu to robí záťaž ako jeden čitateľ: pauza 1,5 s medzi stránkami, jeden dotaz za minútu na zápas.
- **Čo sa nikdy nemení:** hala (miesto), ktorú zadal správca, a čas výkopu, ktorý zadal správca, kým ho zväz nemá.
  Zápasy pridané ručne (iné ID než `szh-...`) sa nedotknú. Nič sa nemaže.
- **Logá:** zväz niektorým tímom (hlavne druhým tímom klubu, napr. „MHK Piešťany B“) logo nedáva. Program ho vtedy nájde inde:
  to isté logo v inej kategórii, alebo logo druhého tímu toho istého klubu („MHK Piešťany A“), alebo to, čo už appka mala.
  Ak logo neexistuje nikde (napr. „TJ Sokol Cífer“), appka ukáže kruh so začiatočnými písmenami.
- **Výpis behu** má pri každom stiahnutí zápasu jeden riadok (stav, skóre, počet udalostí, minúty od výkopu, ticho),
  takže sa dá spätne vidieť, čo federácia vracala.
## Nová sezóna

Zväz každú sezónu vytvorí nové stránky súťaží s novými číslami. V `src/config.js` treba prepísať
`level`, `stage` a `teamId` každej kategórie:

1. Na slovakhandball.sk otvorte súťaž kategórie (Súťaže / Mládež) a z adresy
   `https://slovakhandball.sk/levels/<level>/<stage>` zapíšte obe čísla.
2. `teamId` je číslo nášho tímu: nájdete ho v adrese tímu `https://slovakhandball.sk/teams/<teamId>`
   (otvorte náš tím v tabuľke súťaže).
3. Skúška: **Run workflow** s dry_run. Ak sa pri kategórii ukáže „nenašli sa žiadne zápasy nášho tímu“,
   je zlé `teamId`.

## Keď to prestane fungovať

- Beh sa ukončí chybou (červený krúžok v Actions) a GitHub pošle e-mail. Najčastejšie zväz zmenil web: testy
  alebo výpis povedia „zväz asi zmenil web“. Pošlite ten výpis a opravím parser.
- GitHub vypne plánované behy po 60 dňoch bez aktivity v repozitári. Príde e-mail; v Actions ho zapnete jedným klikom.
- **Zápas, ktorý sa nesleduje:** ak GitHub pred zápasom žiadny beh nespustí, spustite ho ručne asi 30 minút pred výkopom (Actions, Run workflow, mode = auto, dry_run odškrtnúť). Zostane až do konca zápasového dňa.
- Do pol hodiny po zápase sa výsledok objaví aj bez toho, aby ste čokoľvek robili.

## Pre vývojára

```
npm install
npm test                         # viac než 80 testov, nepotrebujú internet
node src/cli.js --mode baseline --dry-run   # skúška proti živému webu, nič nezapíše
```

Bez `FIREBASE_SERVICE_ACCOUNT` beží skúška na prázdnej databáze. S kľúčom v premennej prostredia číta skutočnú
databázu a `--dry-run` len nezapisuje. Súbory: `src/parse.js` číta údaje zo stránok, `src/convert.js` ich mení na
dokumenty appky, `src/sync.js` je logika hlavného sťahovania a sledovania naživo, `src/firestore-store.js` zapisuje.
