#!/usr/bin/env python3
"""EduPage CLI - Nástroj príkazového riadku pre prehľad známok."""

import argparse
import getpass
import json
import os
import re
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from edupage_api import Edupage
from edupage_api.exceptions import (
    BadCredentialsException,
    CaptchaException,
    FailedToParseGradeDataError,
    NotLoggedInException,
    RequestError,
    RetryLaterException,
    SecondFactorFailedException,
)
from edupage_api.grades import EduGrade, Term

# Enable ANSI escape sequences on Windows console
if sys.platform == "win32":
    os.system("")
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

# ANSI Color codes
COLOR_RESET = "\033[0m"
COLOR_BOLD = "\033[1m"
COLOR_DIM = "\033[2m"
COLOR_GREEN = "\033[92m"
COLOR_CYAN = "\033[96m"
COLOR_YELLOW = "\033[93m"
COLOR_MAGENTA = "\033[95m"
COLOR_RED = "\033[91m"
COLOR_BLUE = "\033[94m"


def colorize(text: str, color_code: str, use_color: bool = True) -> str:
    """Obalí text ANSI farebným kódom, pokiaľ je podpora farieb zapnutá."""
    if not use_color:
        return text
    return f"{color_code}{text}{COLOR_RESET}"


def get_grade_color(grade_val: Any, percent: Optional[float] = None) -> str:
    """Určí farbu známky podľa hodnoty alebo percenta."""
    if percent is not None:
        if percent >= 90:
            return COLOR_GREEN
        if percent >= 75:
            return COLOR_CYAN
        if percent >= 60:
            return COLOR_YELLOW
        if percent >= 50:
            return COLOR_MAGENTA
        return COLOR_RED

    try:
        val_str = str(grade_val).strip()
        # Handle "1-", "2-", etc.
        numeric_match = re.match(r"^([1-5])", val_str)
        if numeric_match:
            n = int(numeric_match.group(1))
            if n == 1:
                return COLOR_GREEN
            elif n == 2:
                return COLOR_CYAN
            elif n == 3:
                return COLOR_YELLOW
            elif n == 4:
                return COLOR_MAGENTA
            elif n == 5:
                return COLOR_RED
    except Exception:
        pass

    return COLOR_BOLD


def format_grade_value(grade: EduGrade) -> str:
    """Naformátuje hodnotu známky (percentá / body / známka)."""
    if grade.percent is not None:
        if grade.max_points and grade.max_points != 100:
            return f"{grade.grade_n}/{grade.max_points:g} ({grade.percent:.1f}%)"
        return f"{grade.percent:.1f}%"
    elif grade.max_points is not None:
        return f"{grade.grade_n}/{grade.max_points:g}"
    else:
        return str(grade.grade_n) if grade.grade_n is not None else "-"


def format_weight(grade: EduGrade) -> str:
    """Naformátuje váhu známky."""
    if grade.importance is not None:
        return f"{grade.importance:g}"
    return "-"


def format_comment_and_teacher(grade: EduGrade) -> str:
    """Vráti spojený komentár a meno učiteľa."""
    parts = []
    if grade.comment and grade.comment.strip():
        parts.append(grade.comment.strip())
    if grade.teacher and hasattr(grade.teacher, "name") and grade.teacher.name:
        parts.append(f"učiteľ: {grade.teacher.name}")
    if grade.class_grade_avg is not None:
        parts.append(f"priemer triedy: {grade.class_grade_avg:.2f}")
    return " | ".join(parts) if parts else "-"


def calculate_subject_stats(grades: List[EduGrade]) -> Dict[str, Any]:
    """Vypočíta štatistiku (priemer, vážený priemer) pre daný predmet."""
    weighted_sum = 0.0
    weight_total = 0.0
    count_numeric = 0

    percent_weighted_sum = 0.0
    percent_weight_total = 0.0
    count_percent = 0

    for g in grades:
        weight = g.importance if (g.importance is not None and g.importance > 0) else 1.0

        # Percent check
        if g.percent is not None:
            percent_weighted_sum += g.percent * weight
            percent_weight_total += weight
            count_percent += 1

        # Numeric grade check (1, 2, 3, 4, 5 or 1.5, etc.)
        try:
            val_str = str(g.grade_n).strip()
            # If standard marks like "1-" or "2+", calculate approx
            if val_str.endswith("-") and val_str[:-1].isdigit():
                num = float(val_str[:-1]) + 0.5
            elif val_str.endswith("+") and val_str[:-1].isdigit():
                num = max(1.0, float(val_str[:-1]) - 0.25)
            else:
                num = float(val_str)

            if 1.0 <= num <= 5.0:
                weighted_sum += num * weight
                weight_total += weight
                count_numeric += 1
        except (ValueError, TypeError):
            pass

    avg_grade = (weighted_sum / weight_total) if weight_total > 0 and count_numeric > 0 else None
    avg_percent = (
        (percent_weighted_sum / percent_weight_total)
        if percent_weight_total > 0 and count_percent > 0
        else None
    )

    return {
        "count": len(grades),
        "count_numeric": count_numeric,
        "count_percent": count_percent,
        "avg_grade": avg_grade,
        "avg_percent": avg_percent,
    }


def render_grades_table(
    grades_by_subject: Dict[str, List[EduGrade]],
    user_info: Optional[str] = None,
    use_color: bool = True,
):
    """Zobrazí prehľadnú tabuľku známok zoskupenú podľa predmetov."""
    total_grades = sum(len(items) for items in grades_by_subject.values())
    total_subjects = len(grades_by_subject)

    banner_width = 86
    print(colorize("=" * banner_width, COLOR_CYAN, use_color))
    title_line = " EDUPAGE CLI  -  PREHĽAD ZNÁMOK "
    print(colorize(f"{title_line:^{banner_width}}", COLOR_BOLD, use_color))
    if user_info:
        info_line = f" Používateľ: {user_info} "
        print(colorize(f"{info_line:^{banner_width}}", COLOR_DIM, use_color))
    stats_line = f" Počet predmetov: {total_subjects}  •  Spolu známok: {total_grades} "
    print(colorize(f"{stats_line:^{banner_width}}", COLOR_DIM, use_color))
    print(colorize("=" * banner_width, COLOR_CYAN, use_color))

    if not grades_by_subject:
        print("\n  Nenašli sa žiadne známky pre zvolené obdobie.\n")
        return

    # Column widths
    col_date = 10
    col_grade = 14
    col_weight = 6
    col_title = 26
    col_comment = 22

    for subject, grades in sorted(grades_by_subject.items(), key=lambda x: x[0]):
        stats = calculate_subject_stats(grades)
        stats_str_parts = [f"Známok: {stats['count']}"]
        if stats["avg_grade"] is not None:
            stats_str_parts.append(f"Vážený priemer: {stats['avg_grade']:.2f}")
        if stats["avg_percent"] is not None:
            stats_str_parts.append(f"Priemerné percento: {stats['avg_percent']:.1f}%")
        stats_info = "  |  ".join(stats_str_parts)

        # Subject Header Box
        header_text = f" {subject.upper()} "
        remaining_len = max(2, banner_width - len(header_text) - 4)
        print()
        print(colorize(f"┌─{header_text}{'─' * remaining_len}┐", COLOR_CYAN, use_color))
        print(
            colorize("│ ", COLOR_CYAN, use_color)
            + colorize(f"{stats_info:<{banner_width - 4}}", COLOR_BOLD, use_color)
            + colorize(" │", COLOR_CYAN, use_color)
        )
        print(
            colorize(
                f"├{'─' * (col_date + 2)}┬{'─' * (col_grade + 2)}┬{'─' * (col_weight + 2)}┬{'─' * (col_title + 2)}┬{'─' * (col_comment + 2)}┤",
                COLOR_CYAN,
                use_color,
            )
        )

        # Table Header
        h_row = (
            colorize("│ ", COLOR_CYAN, use_color)
            + colorize(f"{'Dátum':<{col_date}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'Známka':<{col_grade}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'Váha':<{col_weight}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'Názov udalosti':<{col_title}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'Poznámka / Učiteľ':<{col_comment}}", COLOR_DIM, use_color)
            + colorize(" │", COLOR_CYAN, use_color)
        )
        print(h_row)
        print(
            colorize(
                f"├{'─' * (col_date + 2)}┼{'─' * (col_grade + 2)}┼{'─' * (col_weight + 2)}┼{'─' * (col_title + 2)}┼{'─' * (col_comment + 2)}┤",
                COLOR_CYAN,
                use_color,
            )
        )

        # Sort grades by date descending
        sorted_grades = sorted(
            grades,
            key=lambda g: g.date if g.date else datetime.min,
            reverse=True,
        )

        for grade in sorted_grades:
            dt_str = grade.date.strftime("%d.%m.%Y") if grade.date else "-"
            grade_str = format_grade_value(grade)
            weight_str = format_weight(grade)
            title_str = (grade.title or "-")[:col_title]
            comment_str = format_comment_and_teacher(grade)[:col_comment]

            grade_color = get_grade_color(grade.grade_n, grade.percent)
            colored_grade_field = colorize(f"{grade_str:<{col_grade}}", grade_color, use_color)

            row = (
                colorize("│ ", COLOR_CYAN, use_color)
                + f"{dt_str:<{col_date}}"
                + colorize(" │ ", COLOR_CYAN, use_color)
                + colored_grade_field
                + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{weight_str:<{col_weight}}"
                + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{title_str:<{col_title}}"
                + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{comment_str:<{col_comment}}"
                + colorize(" │", COLOR_CYAN, use_color)
            )
            print(row)

        print(
            colorize(
                f"└{'─' * (col_date + 2)}┴{'─' * (col_grade + 2)}┴{'─' * (col_weight + 2)}┴{'─' * (col_title + 2)}┴{'─' * (col_comment + 2)}┘",
                COLOR_CYAN,
                use_color,
            )
        )

    print()


def handle_two_factor(second_factor, edupage: Edupage) -> None:
    """Spracuje dvojfaktorovú autentifikáciu (2FA)."""
    print(colorize("\n[!] Vyžaduje sa dvojfaktorové overenie (2FA)", COLOR_YELLOW))
    print("1 -> Potvrdiť v mobilnej aplikácii EduPage")
    print("2 -> Zadať jednorazový overovací kód")
    choice = input("Zvoľte metódu [1/2]: ").strip()

    if choice == "1":
        print("Potvrďte prihlásenie vo svojej mobilnej aplikácii EduPage...")
        import time

        while not second_factor.is_confirmed():
            time.sleep(0.5)
        second_factor.finish()
        print(colorize("✓ Overenie cez aplikáciu bolo úspešné!", COLOR_GREEN))
    else:
        email = second_factor.email or "váš e-mail"
        prompt = (
            f"Zadajte 2FA kód (alebo 'email' pre odoslanie na {email}, 'resend' pre znovuzaslanie): "
        )

        def send_after_countdown(send_fn):
            import time

            while True:
                try:
                    return send_fn()
                except RetryLaterException as e:
                    print(f"Čakám {e.retry_in_seconds} sekúnd pred opätovným odoslaním...")
                    time.sleep(e.retry_in_seconds)

        while not edupage.is_logged_in:
            code = input(prompt).strip()
            try:
                if code.lower() == "email":
                    send_after_countdown(second_factor.send_email_code)
                    print(f"Kód bol odoslaný na {second_factor.email or email}")
                elif code.lower() == "resend":
                    send_after_countdown(second_factor.resend_notifications)
                    print("Notifikácia bola znova odoslaná.")
                else:
                    second_factor.finish_with_code(code)
                    print(colorize("✓ Kód prijatý, prihlasovanie dokončené!", COLOR_GREEN))
            except SecondFactorFailedException:
                print(colorize("Neplatný kód alebo vypršala platnosť (skúste znova).", COLOR_RED))
            except RequestError as e:
                print(colorize(f"Chyba komunikácie: {e}", COLOR_RED))


def main():
    parser = argparse.ArgumentParser(
        prog="edupage-cli",
        description="Jednoduchý CLI program pre prehľad známok z EduPage.",
    )
    parser.add_argument(
        "-u",
        "--username",
        type=str,
        default=os.getenv("EDUPAGE_USERNAME"),
        help="Prihlasovacie meno alebo e-mail do EduPage (možno použiť aj EDUPAGE_USERNAME).",
    )
    parser.add_argument(
        "-p",
        "--password",
        type=str,
        default=os.getenv("EDUPAGE_PASSWORD"),
        help="Heslo (možno použiť aj EDUPAGE_PASSWORD). Ak nie je zadané, program sa spýta bezpečne.",
    )
    parser.add_argument(
        "-s",
        "--subdomain",
        type=str,
        default=os.getenv("EDUPAGE_SUBDOMAIN"),
        help="Subdoména školy (napr. 'gympos' pre gympos.edupage.org). Ak nezadáte, program sa pokúsi o auto-login.",
    )
    parser.add_argument(
        "-t",
        "--term",
        type=int,
        choices=[1, 2],
        default=None,
        help="Polrok (1 pre 1. polrok, 2 pre 2. polrok). Predvolene aktuálne obdobie.",
    )
    parser.add_argument(
        "-y",
        "--year",
        type=int,
        default=None,
        help="Školský rok (napr. 2026 pre školský rok 2026/2027).",
    )
    parser.add_argument(
        "--subject",
        type=str,
        default=None,
        help="Filtrovať iba konkrétny predmet (napr. --subject Matematika).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Vypísať známky v strojovom JSON formáte.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Vypnúť farebné zvýrazňovanie v termináli.",
    )

    args = parser.parse_args()

    # Determine color output
    use_color = (
        not args.no_color
        and not os.getenv("NO_COLOR")
        and sys.stdout.isatty()
    )

    # Interactive input if credentials missing
    username = args.username
    if not username:
        username = input("Prihlasovacie meno (alebo e-mail): ").strip()
        if not username:
            print("Chyba: Nebolo zadané prihlasovacie meno.", file=sys.stderr)
            sys.exit(1)

    password = args.password
    if not password:
        password = getpass.getpass("Heslo: ")
        if not password:
            print("Chyba: Nebolo zadané heslo.", file=sys.stderr)
            sys.exit(1)

    subdomain = args.subdomain
    if subdomain is None and not os.getenv("EDUPAGE_SUBDOMAIN"):
        entered_subdomain = input("Subdoména školy (Enter pre automatické zistenie): ").strip()
        subdomain = entered_subdomain if entered_subdomain else None

    # Connect to EduPage
    edupage = Edupage()

    print(colorize("Pripájam sa k EduPage...", COLOR_DIM, use_color))
    try:
        if subdomain:
            second_factor = edupage.login(username, password, subdomain)
        else:
            second_factor = edupage.login_auto(username, password)

        if second_factor:
            handle_two_factor(second_factor, edupage)

    except BadCredentialsException:
        print(
            colorize("Chyba: Nesprávne prihlasovacie meno, heslo alebo subdoména školy!", COLOR_RED),
            file=sys.stderr,
        )
        sys.exit(1)
    except CaptchaException:
        print(
            colorize(
                "Chyba: EduPage vyžaduje overenie Captcha. Prihláste sa najprv cez webový prehliadač.",
                COLOR_RED,
            ),
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as e:
        print(colorize(f"Chyba pri prihlasovaní: {e}", COLOR_RED), file=sys.stderr)
        sys.exit(1)

    if not edupage.is_logged_in:
        print(colorize("Chyba: Prihlásenie sa nepodarilo.", COLOR_RED), file=sys.stderr)
        sys.exit(1)

    # Fetch grades
    try:
        print(colorize("Sťahujem prehľad známok...", COLOR_DIM, use_color))
        term_enum = None
        if args.term == 1:
            term_enum = Term.FIRST
        elif args.term == 2:
            term_enum = Term.SECOND

        if term_enum and args.year:
            grades = edupage.get_grades_for_term(args.year, term_enum)
        else:
            grades = edupage.get_grades()

        # Group by subject
        grades_by_subject: Dict[str, List[EduGrade]] = {}
        for g in grades:
            subj_name = g.subject_name or "Neznámy predmet"
            if args.subject:
                if args.subject.lower() not in subj_name.lower():
                    continue
            grades_by_subject.setdefault(subj_name, []).append(g)

        # Output as JSON or formatted Table
        if args.json:
            json_output = {}
            for subj, glist in grades_by_subject.items():
                json_output[subj] = [
                    {
                        "event_id": g.event_id,
                        "title": g.title,
                        "grade": g.grade_n,
                        "percent": g.percent,
                        "max_points": g.max_points,
                        "importance": g.importance,
                        "date": g.date.isoformat() if g.date else None,
                        "comment": g.comment,
                        "teacher": g.teacher.name if g.teacher else None,
                        "class_grade_avg": g.class_grade_avg,
                    }
                    for g in glist
                ]
            print(json.dumps(json_output, ensure_ascii=False, indent=2))
        else:
            # User info for banner
            user_display = edupage.username
            if edupage.subdomain:
                user_display += f" ({edupage.subdomain}.edupage.org)"
            render_grades_table(grades_by_subject, user_info=user_display, use_color=use_color)

    except Exception as e:
        print(colorize(f"Chyba pri sťahovaní známok: {e}", COLOR_RED), file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            edupage.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main()
