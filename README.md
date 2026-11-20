# EDUPAGE CLI

> Moderný, vysoko-kontrastný terminálový monitor a klient pre EduPage inšpirovaný nástrojom **btop**.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-orange.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()

---

## Prehľad

**EDUPAGE CLI** prináša rýchle, responzívne a estetické rozhranie priamo do vášho terminálu. Poskytuje okamžitý prehľad o aktuálnom školskom dni, rozvrhu, známkach, jedálnom lístku a domácich úlohách bez nutnosti otvárať prehliadač alebo mobilnú aplikáciu.

---

## Hlavné funkcie

- **TUI Monitor v štýle btop**:
  - **Braille krivka vývoja priemeru (GPA Trend)** vykresľovaná v reálnom čase.
  - **Stĺpcový histogram rozdelenia známok** (počet jednotiek, dvojok, trojok, štvoriek a pätiek).
  - **Živý ukazovateľ (Gauge bar)** aktuálnej hodiny alebo prestávky s percentuálnym priebehom a zostávajúcim časom.
  - **Dnešný rozvrh hodín** s inteligentnou detekciou stavu (`>> TERAZ`, `> NA RADE`, `HOTOVO`, `[ODPADLA]`).
  - **Prehľad jedálne** s informáciou o objednanom obede (Menu A / B / odhlásené) a časoch výdaja.
  - **Najbližšie zadania** s termínmi a menami vyučujúcich.

- **5 Plnohodnotných interaktívnych kariet**:
  - **`1: MONITOR`** – Domovská obrazovka s prehľadovými panelmi a grafmi.
  - **`2: ZNÁMKY`** – Celoobrazovkový prehľad predmetov, priemerov a kompletná história všetkých zapísaných známok s váhami a poznámkami.
  - **`3: ROZVRH`** – Kompletný rozvrh dňa so skupinami, učebňami a preberanými témami hodín.
  - **`4: OBEDY`** – Detailný jedálny lístok na dnešný deň, gramáž, alergény a stav objednávky.
  - **`5: ÚLOHY`** – Zoznam všetkých aktívnych domácich úloh, projektov a písomiek.

- **Korektný slovenský systém hodnotenia**:
  - Výpočet celkového študijného priemeru (GPA) ako aritmetického priemeru výsledných známok jednotlivých predmetov.
  - Automatické určenie celkového prospechu (*Prospel s vyznamenaním*, *Prospel veľmi dobre*, *Prospel*, *Neprospel*).

- **Responzívny dizajn & Fullscreen**:
  - Automatické maximalizovanie okna pri štarte cez `run.bat`.
  - Pevné zarovnanie stĺpcov s ochranou proti zliepaniu textu a elegantné skracovanie dlhých názvov s trojbodkou (`…`).

- **Automatické zapamätanie prihlásenia**:
  - Prihlasovacie meno a subdoména školy sa bezpečne ukladajú lokálne (`~/.edupage/`), takže prihlásenie prebieha bleskovo a bez opätovného zadávania údajov.

---

## Požiadavky

- **Node.js** >= 18
- **Python** >= 3.10
- Podporovaný terminál s UTF-8 kódovaním (Windows Terminal, Alacritty, Kitty, iTerm2, WezTerm alebo bežný PowerShell / cmd)

---

## Inštalácia

1. Naklonujte repozitár:
   ```bash
   git clone https://github.com/JakubDotExe/EDUPAGE-CLI.git
   cd EDUPAGE-CLI
   ```

2. Nainštalujte Node.js balíčky:
   ```bash
   npm install
   ```

3. Nainštalujte Python závislosti:
   ```bash
   pip install requests
   # alebo
   pip install -e .
   ```

---

## Spustenie

### Rýchle spustenie (Windows):
Stačí spustiť dávkový súbor:
```cmd
run.bat
```
*(Automaticky maximalizuje terminálové okno a spustí monitor.)*

### Spustenie cez terminál (Windows / Linux / macOS):
```bash
npm start
# alebo
node app.js
```

Pri prvom spustení vás aplikácia vyzve na zadanie vašej EduPage subdomény (napr. `ssnd`), prihlasovacieho mena a hesla. Údaje sa uložia a pri ďalšom spustení nabehnú automaticky.

---

## Ovládanie a klávesové skratky

| Klávesa | Akcia |
| :--- | :--- |
| `1` – `5` | Priamy skok na kartu (`1: Monitor`, `2: Známky`, `3: Rozvrh`, `4: Obedy`, `5: Úlohy`) |
| `←` / `→` | Prepínanie medzi kartami |
| `Tab` | Prepínanie fokusu medzi oknami a tabuľkami na aktívnej karte |
| `↑` / `↓` | Pohyb a rolovanie v zoznamoch a tabuľkách |
| `r` | Okamžitá manuálna synchronizácia údajov zo servera EduPage |
| `q` / `Esc` | Ukončenie aplikácie |

---

## Neinteraktívny režim (Rýchle príkazy)

Ak potrebujete rýchlo skontrolovať údaje z príkazového riadka bez interaktívneho monitora:

```bash
python cli.py grades                   # Prehľad známok a priemerov
python cli.py timetable --week         # Rozvrh hodín na celý týždeň
python cli.py lunches                  # Dnešné menu v jedálni
python cli.py homework                 # Aktuálne úlohy a zadania
python cli.py ringing                  # Časy zvonenia a aktuálna hodina
python cli.py substitution --tomorrow  # Suplovanie na zajtrajší deň
python cli.py logout                   # Odhlásenie a zmazanie uložených údajov
```

---

## Konfigurácia a vyrovnávacia pamäť

Konfigurácia a lokálna vyrovnávacia pamäť sú uložené v domovskom adresári používateľa:
```text
~/.edupage/
├── credentials.json       # Bezpečne uložené prihlasovacie údaje
└── dashboard_cache.json   # Lokálna kópia posledných načítaných dát pre okamžitý štart
```

---

## Licencia

Tento projekt je licencovaný pod licenciou **GNU General Public License v3.0 (GPL-3.0)**. Podrobnosti nájdete v súbore [LICENSE](LICENSE).
