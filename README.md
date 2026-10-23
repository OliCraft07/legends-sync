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

- **Hlavné sťahovanie** (`baseline`): z každej súťaže stiahne jednu stránku (všetky zápasy a tabuľka, 1 až 3 MB), zapíše,
  čo sa zmenilo, a pri odohratých zápasoch si prečíta ich vlastnú stránku (súpisky, góly, tresty, rozhodcovia).
  Beží v dni so zápasom a deň po ňom každú hodinu, inak každú 6. hodinu.
- **Naživo** (`live`): od 10 minút pred výkopom do 150 minút po ňom číta stránku zápasu každú minútu, zapisuje skóre
  a priebeh (appka ukáže červené **NAŽIVO**) a skončí po záverečnom hvizde.
- Zväzu to robí záťaž ako jeden čitateľ: pauza 1,5 s medzi stránkami, jeden dotaz za minútu na zápas.
- **Čo sa nikdy nemení:** hala (miesto), ktorú zadal správca, a čas výkopu, ktorý zadal správca, kým ho zväz nemá.
  Zápasy pridané ručne (iné ID než `szh-...`) sa nedotknú. Nič sa nemaže.

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
