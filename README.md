# `edupage-api` &middot; [![Current version on PyPI](https://img.shields.io/pypi/v/edupage-api)](https://pypi.org/project/edupage-api/) [![Supported Python versions](https://img.shields.io/pypi/pyversions/edupage-api)](https://pypi.org/project/edupage-api/) [![PyPI - Downloads](https://img.shields.io/pypi/dw/edupage-api)](https://pypistats.org/packages/edupage-api) [![CodeFactor](https://www.codefactor.io/repository/github/EdupageAPI/edupage-api/badge)](https://www.codefactor.io/repository/github/EdupageAPI/edupage-api)

This Python library allows easy access to EduPage. It's not a Selenium web scraper. It makes requests directly to EduPage's endpoints and parses the HTML document.

# EduPage CLI

Moderný terminálový TUI monitor a klient pre EduPage v skutočnom štýle **btop** (grafy, Braille krivky, stĺpcové grafy, progress gauge a responzívny 12x12 grid).

```bash
# Spustenie moderného btop monitora (Node.js)
npm start
# alebo
node app.js
# alebo vo Windows dvojklik na run.bat
```

### Hlavné vlastnosti:
- **Živé grafy v štýle btop**: Braille krivka vývoja študijného priemeru (GPA History Line Graph) a stĺpcový graf distribúcie známok (1 až 5).
- **Živý progress bar hodiny**: Gauge ukazujúci presný priebeh a minúty aktuálnej hodiny.
- **Domovská obrazovka (Home Dashboard)**: Živý monitor s hodinami, časom posledného refreshu, dnešným rozvrhom (s indikáciou aktuálnej a nasledujúcej hodiny), poslednými známkami, dnešným obedom v jedálni a aktívnymi domácimi úlohami.
- **Celoobrazovkový prehľad známok (`[1]`)**: Karty predmetov so študijným priemerom (GPA), váženými priemermi, percentami a podrobnými tabuľkami hodnotení.
- **Rozvrh hodín**: Prehľad na dnes, zajtrajšok, celý týždeň alebo ľubovoľný dátum s vyznačením odpadnutých hodín.
- **Jedáleň a obedy**: Stav objednávky (Menu A/B, odhlásené), časy výdaja, alergény.
- **Automatické zapamätanie údajov**: Automaticky si pamätá prihlasovacie meno a subdoménu `ssnd`.
- **Rýchla klávesová navigácia**: Klávesy `1`, `g` (známky), `r` (refresh), `q` (ukončenie).

### Rýchle príkazy (neinteraktívny režim):
```bash
python cli.py grades                   # Celoobrazovkový prehľad známok
python cli.py timetable --week         # Rozvrh na celý týždeň
python cli.py substitution --tomorrow  # Suplovanie na zajtra
python cli.py lunches                  # Dnešný obed a jedálny lístok
python cli.py homework                 # Domáce úlohy a písomky
python cli.py ringing                  # Najbližšie zvonenie a rozpis
python cli.py teachers -q "novak"      # Vyhľadanie učiteľa
python cli.py logout                   # Zmazanie uloženého prihlásenia
```

# Installing
__Warning__: Requires Python >= 3.9!

You can install this library using [`pip`](https://pypi.org/project/pip/):

```
pip install edupage-api
```

# Usage

## Login

You can log in easily, it works with any school:

```python
from edupage_api import Edupage
from edupage_api.exceptions import BadCredentialsException, CaptchaException

edupage = Edupage()

try:
    edupage.login("Username", "Password", "Your school's subdomain")
except BadCredentialsException:
    print("Wrong username or password!")
except CaptchaException:
    print("Captcha required!")
```

# Documentation
The docs are available [here](https://edupageapi.github.io/edupage-api/)

# I have a problem or an idea!

- If you find any issue with this code, or it doesn't work please, let us know by opening an [issue](https://github.com/EdupageAPI/edupage-api/issues/new/choose)!
- Feel free to suggest any other features! Just open an [issue with the _Feature Request_ tag](https://github.com/EdupageAPI/edupage-api/issues/new?labels=feature+request&template=feature_request.md&title=%5BFeature+request%5D+).
- If you, even better, have fixed the issue, added a new feature, or made something work better, please, open a [pull request](https://github.com/EdupageAPI/edupage-api/compare)!

# Discord
https://discord.gg/fg6zBu9ZAn
