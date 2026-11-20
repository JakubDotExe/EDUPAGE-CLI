# `edupage-api` &middot; [![Current version on PyPI](https://img.shields.io/pypi/v/edupage-api)](https://pypi.org/project/edupage-api/) [![Supported Python versions](https://img.shields.io/pypi/pyversions/edupage-api)](https://pypi.org/project/edupage-api/) [![PyPI - Downloads](https://img.shields.io/pypi/dw/edupage-api)](https://pypistats.org/packages/edupage-api) [![CodeFactor](https://www.codefactor.io/repository/github/EdupageAPI/edupage-api/badge)](https://www.codefactor.io/repository/github/EdupageAPI/edupage-api)

This Python library allows easy access to EduPage. It's not a Selenium web scraper. It makes requests directly to EduPage's endpoints and parses the HTML document.

# EduPage CLI

Moderný interaktívny nástroj príkazového riadku pre EduPage so všetkými funkciami:

```bash
# Spustenie interaktívneho dashboardu
python cli.py
# alebo vo Windows dvojklik na run.bat
```

### Čo všetko dokáže:
- **📊 Známky a hodnotenia**: Zoznam známok podľa predmetov, vážené priemery, percentá, detaily písomiek.
- **📅 Rozvrh hodín**: Dnešok, zajtrajšok, celý týždeň alebo vlastný dátum, zobrazenie odpadnutých hodín, učební a učiteľov.
- **🔄 Suplovanie**: Zoznam chýbajúcich učiteľov a zmeny v rozvrhu (zastupovania).
- **🍽️ Obedy a jedálny lístok**: Prehľad jedál na dnes a celý týždeň, stav objednávky (Menu A/B, odhlásené), alergény a gramáže.
- **📝 Domáce úlohy a časová os**: Zoznam zadaných úloh, termíny písomiek a správy od učiteľov.
- **🔔 Zvonenie**: Čas najbližšieho zvonenia, dĺžka prestávky a denný rozpis hodín školy.
- **👨‍🏫 Učitelia a kontakty**: Vyhľadávanie učiteľov a ich kabinety / učebne.
- **💾 Bezpečné ukladanie prihlásenia**: Možnosť zapamätať prihlásenie na vašom PC, aby ste nemuseli heslo zadávať zakaždým.

### Rýchle príkazy (neinteraktívny režim):
```bash
python cli.py grades                   # Prehľad známok
python cli.py timetable --week         # Rozvrh na celý týždeň
python cli.py substitution --tomorrow  # Suplovanie na zajtra
python cli.py lunches                  # Dnešný obed a jedálny lístok
python cli.py homework                 # Domáce úlohy a písomky
python cli.py ringing                  # Najbližšie zvonenie
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
