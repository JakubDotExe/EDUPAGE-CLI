#!/usr/bin/env python3
"""EduPage CLI - Moderný minimalistický TUI nástroj v btop štýle pre EduPage."""

import argparse
import getpass
import json
import os
import re
import sys
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional, Tuple

from edupage_api import Edupage
from edupage_api.exceptions import (
    BadCredentialsException,
    CaptchaException,
    FailedToChangeMealError,
    FailedToParseGradeDataError,
    NotLoggedInException,
    RequestError,
    RetryLaterException,
    SecondFactorFailedException,
)
from edupage_api.grades import EduGrade, EduTextGrade, Term
from edupage_api.lunches import Meal, Meals, Menu
from edupage_api.people import EduAccount, EduStudent, EduTeacher
from edupage_api.ringing import RingingTime, RingingType
from edupage_api.substitution import Action, TimetableChange
from edupage_api.timeline import EventType, TimelineEvent
from edupage_api.timetables import Lesson, Timetable

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

# ANSI Color codes (btop dark theme inspired)
COLOR_RESET = "\033[0m"
COLOR_BOLD = "\033[1m"
COLOR_DIM = "\033[2m"
COLOR_UNDERLINE = "\033[4m"
COLOR_GREEN = "\033[92m"
COLOR_CYAN = "\033[96m"
COLOR_YELLOW = "\033[93m"
COLOR_MAGENTA = "\033[95m"
COLOR_RED = "\033[91m"
COLOR_BLUE = "\033[94m"
COLOR_WHITE = "\033[97m"

# Configuration file paths
CONFIG_DIR = os.path.expanduser("~/.edupage")
CONFIG_FILE = os.path.join(CONFIG_DIR, "credentials.json")
LOCAL_CONFIG_FILE = ".edupage_credentials.json"
CLI_VERSION = "v1.0.0"


# ==============================================================================
# Helper Functions & Formatting
# ==============================================================================

def colorize(text: str, color_code: str, use_color: bool = True) -> str:
    """Obalí text ANSI farebným kódom, pokiaľ je podpora farieb zapnutá."""
    if not use_color:
        return text
    return f"{color_code}{text}{COLOR_RESET}"


def clear_screen() -> None:
    """Vyčistí terminálové okno."""
    os.system("cls" if sys.platform == "win32" else "clear")


def load_saved_credentials() -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Načíta uložené prihlasovacie údaje z konfigurácie alebo premenných prostredia."""
    username = os.getenv("EDUPAGE_USERNAME")
    password = os.getenv("EDUPAGE_PASSWORD")
    subdomain = os.getenv("EDUPAGE_SUBDOMAIN")

    for path in [LOCAL_CONFIG_FILE, CONFIG_FILE]:
        if not (username and password and subdomain) and os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    username = username or data.get("username")
                    password = password or data.get("password")
                    subdomain = subdomain or data.get("subdomain")
            except Exception:
                pass

    return username, password, subdomain


def save_credentials(username: str, password: str, subdomain: Optional[str]) -> bool:
    """Uloží prihlasovacie údaje do používateľského adresára."""
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        data = {
            "username": username,
            "password": password,
            "subdomain": subdomain,
            "updated_at": datetime.now().isoformat(),
        }
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return True
    except Exception:
        return False


def clear_saved_credentials() -> bool:
    """Zmaže uložené prihlasovacie údaje."""
    removed = False
    for path in [CONFIG_FILE, LOCAL_CONFIG_FILE]:
        if os.path.isfile(path):
            try:
                os.remove(path)
                removed = True
            except Exception:
                pass
    return removed


def get_display_user_name(edupage: Edupage) -> str:
    """Získa čitateľné meno prihláseného používateľa."""
    if edupage.data and isinstance(edupage.data, dict):
        for key in ["meno", "user_meno", "fullname", "name", "p_meno"]:
            val = edupage.data.get(key)
            if val and isinstance(val, str):
                return val
    return edupage.username or "User"


def print_banner(edupage: Optional[Edupage] = None, use_color: bool = True) -> None:
    """Zobrazí minimalistický btop-style hlavičkový box."""
    width = 86
    title = f"EDUPAGE CLI [{CLI_VERSION}]"
    right_tag = "ONLINE" if (edupage and edupage.is_logged_in) else "OFFLINE"
    right_tag_colored = colorize(f"[{right_tag}]", COLOR_GREEN if right_tag == "ONLINE" else COLOR_DIM, use_color)

    title_len = len(title) + len(right_tag) + 4
    mid_bar = "─" * max(4, width - title_len - 8)

    top_border = f"╭─ {colorize(title, COLOR_BOLD, use_color)} {colorize(mid_bar, COLOR_CYAN, use_color)} {right_tag_colored} ─╮"
    print(colorize(top_border, COLOR_CYAN, use_color))

    if edupage and edupage.is_logged_in:
        user_name = get_display_user_name(edupage)
        host = f"{edupage.subdomain}.edupage.org" if edupage.subdomain else "edupage.org"
        time_now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        info_line = f" USER: {user_name}  |  HOST: {host}  |  TIME: {time_now}"
        print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f"{info_line:<{width - 4}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color))

    bottom_border = f"╰{'─' * (width - 2)}╯"
    print(colorize(bottom_border, COLOR_CYAN, use_color))


# ==============================================================================
# Authentication & 2FA Handler
# ==============================================================================

def handle_two_factor(second_factor, edupage: Edupage, use_color: bool = True) -> None:
    """Spracuje dvojfaktorovú autentifikáciu (2FA)."""
    print(colorize("\n[2FA] Authentication challenge required.", COLOR_YELLOW, use_color))
    print("  [1] Approve via mobile app push notification")
    print("  [2] Enter one-time code (SMS / Email)")
    choice = input("  select [1/2]: ").strip()

    if choice == "1":
        print("  waiting for mobile push confirmation...")
        import time
        while not second_factor.is_confirmed():
            time.sleep(0.5)
        second_factor.finish()
        print(colorize("  [OK] 2FA confirmed via mobile app.", COLOR_GREEN, use_color))
    else:
        email = second_factor.email or "registered email"
        prompt = f"  enter 2FA code (or 'email' / 'resend'): "

        def send_after_countdown(send_fn):
            import time
            while True:
                try:
                    return send_fn()
                except RetryLaterException as e:
                    print(f"  cooling down: {e.retry_in_seconds}s...")
                    time.sleep(e.retry_in_seconds)

        while not edupage.is_logged_in:
            code = input(prompt).strip()
            try:
                if code.lower() == "email":
                    send_after_countdown(second_factor.send_email_code)
                    print(f"  code sent to {second_factor.email or email}")
                elif code.lower() == "resend":
                    send_after_countdown(second_factor.resend_notifications)
                    print("  notification resent.")
                else:
                    second_factor.finish_with_code(code)
                    print(colorize("  [OK] 2FA verification succeeded.", COLOR_GREEN, use_color))
            except SecondFactorFailedException:
                print(colorize("  [ERR] Invalid or expired code. Try again.", COLOR_RED, use_color))
            except RequestError as e:
                print(colorize(f"  [ERR] Connection error: {e}", COLOR_RED, use_color))


def authenticate(
    username: Optional[str] = None,
    password: Optional[str] = None,
    subdomain: Optional[str] = None,
    use_color: bool = True,
    interactive: bool = True,
) -> Optional[Edupage]:
    """Prihlási používateľa do EduPage s podporou ukladania a 2FA."""
    saved_user, saved_pass, saved_sub = load_saved_credentials()

    username = username or saved_user
    password = password or saved_pass
    subdomain = subdomain or saved_sub

    if not username and interactive:
        username = input("Username / Email: ").strip()
        if not username:
            print(colorize("[ERR] Username is required.", COLOR_RED, use_color))
            return None

    if not password and interactive:
        password = getpass.getpass("Password: ")
        if not password:
            print(colorize("[ERR] Password is required.", COLOR_RED, use_color))
            return None

    if subdomain is None and interactive:
        sub = input("School subdomain (e.g. 'ssnd' or Enter for auto-detect): ").strip()
        subdomain = sub if sub else None

    edupage = Edupage()
    print(colorize("[...] Connecting to EduPage...", COLOR_DIM, use_color))

    try:
        if subdomain:
            second_factor = edupage.login(username, password, subdomain)
        else:
            second_factor = edupage.login_auto(username, password)

        if second_factor:
            handle_two_factor(second_factor, edupage, use_color=use_color)

    except BadCredentialsException:
        print(colorize("[ERR] Bad credentials or invalid school subdomain.", COLOR_RED, use_color))
        return None
    except CaptchaException:
        print(colorize("[ERR] Captcha challenge triggered. Log in via web browser first.", COLOR_RED, use_color))
        return None
    except Exception as e:
        print(colorize(f"[ERR] Login failed: {e}", COLOR_RED, use_color))
        return None

    if not edupage.is_logged_in:
        print(colorize("[ERR] Authentication failed.", COLOR_RED, use_color))
        return None

    # Offer saving credentials if not already saved
    if interactive and not os.path.isfile(CONFIG_FILE) and not os.path.isfile(LOCAL_CONFIG_FILE):
        try:
            choice = input("\nSave credentials locally to ~/.edupage/credentials.json? [y/N]: ").strip().lower()
            if choice in ["y", "yes", "a", "ano"]:
                save_credentials(username, password, edupage.subdomain or subdomain)
                print(colorize("[OK] Credentials saved.", COLOR_GREEN, use_color))
        except Exception:
            pass

    return edupage


# ==============================================================================
# Feature 1: Grades & Averages (Známky)
# ==============================================================================

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
    """Naformátuje hodnotu známky."""
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
    return f"{grade.importance:g}" if grade.importance is not None else "-"


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
    """Vypočíta štatistiku (vážený priemer, percentá) pre daný predmet."""
    weighted_sum = 0.0
    weight_total = 0.0
    count_numeric = 0

    percent_weighted_sum = 0.0
    percent_weight_total = 0.0
    count_percent = 0

    for g in grades:
        weight = g.importance if (g.importance is not None and g.importance > 0) else 1.0

        if g.percent is not None:
            percent_weighted_sum += g.percent * weight
            percent_weight_total += weight
            count_percent += 1

        try:
            val_str = str(g.grade_n).strip()
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
) -> None:
    """Zobrazí prehľadnú tabuľku známok zoskupenú podľa predmetov v btop štýle."""
    total_grades = sum(len(items) for items in grades_by_subject.values())
    total_subjects = len(grades_by_subject)

    width = 86
    title_text = "EDUPAGE CLI - PREHLAD ZNAMOK"
    stats_text = f"SUBJECTS: {total_subjects}  |  TOTAL MARKS: {total_grades}"
    
    print(colorize(f"╭─ {title_text} {'─' * (width - len(title_text) - 6)}╮", COLOR_CYAN, use_color))
    if user_info:
        user_line = f" USER: {user_info}"
        print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f"{user_line:<{width - 4}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color))
    print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f" {stats_text:<{width - 4}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color))
    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    if not grades_by_subject:
        print(colorize("\n  [i] No grades found for the selected period.\n", COLOR_DIM, use_color))
        return

    col_date = 10
    col_grade = 14
    col_weight = 6
    col_title = 26
    col_comment = 22

    for subject, grades in sorted(grades_by_subject.items(), key=lambda x: x[0]):
        stats = calculate_subject_stats(grades)
        stats_str_parts = [f"MARKS: {stats['count']}"]
        if stats["avg_grade"] is not None:
            stats_str_parts.append(f"AVG: {stats['avg_grade']:.2f}")
        if stats["avg_percent"] is not None:
            stats_str_parts.append(f"PERCENT: {stats['avg_percent']:.1f}%")
        stats_info = "  |  ".join(stats_str_parts)

        subj_header = f" {subject.upper()} "
        rem_len = max(2, width - len(subj_header) - len(stats_info) - 8)
        header_bar = f"╭─ {colorize(subj_header, COLOR_BOLD, use_color)}{'─' * rem_len} [ {colorize(stats_info, COLOR_CYAN, use_color)} ] ─╮"
        print()
        print(colorize(header_bar, COLOR_CYAN, use_color))

        h_row = (
            colorize("│ ", COLOR_CYAN, use_color)
            + colorize(f"{'DATE':<{col_date}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'MARK':<{col_grade}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'WEIGHT':<{col_weight}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'ASSIGNMENT / EVENT':<{col_title}}", COLOR_DIM, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'NOTE / TEACHER':<{col_comment}}", COLOR_DIM, use_color)
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
                f"╰{'─' * (col_date + 2)}┴{'─' * (col_grade + 2)}┴{'─' * (col_weight + 2)}┴{'─' * (col_title + 2)}┴{'─' * (col_comment + 2)}╯",
                COLOR_CYAN,
                use_color,
            )
        )

    print()


def view_grades(edupage: Edupage, use_color: bool = True, subject_filter: Optional[str] = None) -> None:
    """Zobrazí známky a umožní filtrovanie / prepínanie polroka."""
    try:
        print(colorize("[...] Loading grades...", COLOR_DIM, use_color))
        grades = edupage.get_grades()

        grades_by_subject: Dict[str, List[EduGrade]] = {}
        for g in grades:
            subj = g.subject_name or "Unknown Subject"
            if subject_filter and subject_filter.lower() not in subj.lower():
                continue
            grades_by_subject.setdefault(subj, []).append(g)

        user_info = f"{get_display_user_name(edupage)} ({edupage.subdomain})"
        render_grades_table(grades_by_subject, user_info=user_info, use_color=use_color)

    except Exception as e:
        print(colorize(f"[ERR] Failed to fetch grades: {e}", COLOR_RED, use_color))


# ==============================================================================
# Feature 2: Timetable (Rozvrh hodín)
# ==============================================================================

def render_day_timetable(timetable: Optional[Timetable], target_date: date, use_color: bool = True) -> None:
    """Vykreslí rozvrh na konkrétny deň v btop štýle."""
    sk_days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    day_name = sk_days[target_date.weekday()]
    date_str = f"{day_name} {target_date.strftime('%Y-%m-%d')}"

    width = 86
    print(colorize(f"\n╭─ TIMETABLE [{date_str}] {'─' * (width - len(date_str) - 20)}╮", COLOR_CYAN, use_color))

    if not timetable or not timetable.lessons:
        print(colorize("│  No lessons scheduled for this day.                                         │", COLOR_DIM, use_color))
        print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))
        return

    col_period = 4
    col_time = 13
    col_subject = 22
    col_room = 10
    col_teacher = 16
    col_topic = 24

    h_row = (
        colorize("│ ", COLOR_CYAN, use_color)
        + colorize(f"{'#':<{col_period}}", COLOR_DIM, use_color)
        + colorize(" │ ", COLOR_CYAN, use_color)
        + colorize(f"{'TIME':<{col_time}}", COLOR_DIM, use_color)
        + colorize(" │ ", COLOR_CYAN, use_color)
        + colorize(f"{'SUBJECT':<{col_subject}}", COLOR_DIM, use_color)
        + colorize(" │ ", COLOR_CYAN, use_color)
        + colorize(f"{'ROOM':<{col_room}}", COLOR_DIM, use_color)
        + colorize(" │ ", COLOR_CYAN, use_color)
        + colorize(f"{'TEACHER':<{col_teacher}}", COLOR_DIM, use_color)
        + colorize(" │ ", COLOR_CYAN, use_color)
        + colorize(f"{'CURRICULUM':<{col_topic}}", COLOR_DIM, use_color)
        + colorize(" │", COLOR_CYAN, use_color)
    )
    print(h_row)
    div_row = f"├{'─' * (col_period + 2)}┼{'─' * (col_time + 2)}┼{'─' * (col_subject + 2)}┼{'─' * (col_room + 2)}┼{'─' * (col_teacher + 2)}┼{'─' * (col_topic + 2)}┤"
    print(colorize(div_row, COLOR_CYAN, use_color))

    sorted_lessons = sorted(
        timetable.lessons,
        key=lambda l: (l.period if l.period is not None else 99, l.start_time or time.min),
    )

    for l in sorted_lessons:
        period_str = str(l.period) if l.period is not None else "-"
        time_str = f"{l.start_time.strftime('%H:%M')}-{l.end_time.strftime('%H:%M')}" if (l.start_time and l.end_time) else "-"

        subj_name = l.subject.name if l.subject else (l.curriculum if l.is_event else "Free period")
        subj_name = (subj_name or "-")[:col_subject]

        room_str = ", ".join(c.name for c in l.classrooms) if l.classrooms else "-"
        room_str = room_str[:col_room]

        teacher_str = ", ".join(t.name for t in l.teachers) if l.teachers else "-"
        teacher_str = teacher_str[:col_teacher]

        topic_str = (l.curriculum or "-")[:col_topic]

        # Status badge
        if l.is_cancelled:
            subj_col = colorize(f"{subj_name} [CANCELLED]", COLOR_RED, use_color)
        elif l.is_event:
            subj_col = colorize(f"{subj_name} [EVENT]", COLOR_CYAN, use_color)
        elif l.is_online_lesson():
            subj_col = colorize(f"{subj_name} [ONLINE]", COLOR_BLUE, use_color)
        else:
            subj_col = colorize(f"{subj_name:<{col_subject}}", COLOR_BOLD, use_color)

        row = (
            colorize("│ ", COLOR_CYAN, use_color)
            + f"{period_str:<{col_period}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{time_str:<{col_time}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{subj_col:<{col_subject if not use_color else col_subject + 10}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{room_str:<{col_room}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{teacher_str:<{col_teacher}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{topic_str:<{col_topic}}"
            + colorize(" │", COLOR_CYAN, use_color)
        )
        print(row)

    print(colorize(f"╰{'─' * (col_period + 2)}┴{'─' * (col_time + 2)}┴{'─' * (col_subject + 2)}┴{'─' * (col_room + 2)}┴{'─' * (col_teacher + 2)}┴{'─' * (col_topic + 2)}╯", COLOR_CYAN, use_color))


def view_timetable(edupage: Edupage, target_date: Optional[date] = None, week_mode: bool = False, use_color: bool = True) -> None:
    """Zobrazí rozvrh hodín na deň alebo celý týždeň."""
    target_date = target_date or date.today()

    if week_mode:
        start_of_week = target_date - timedelta(days=target_date.weekday())
        print(colorize(f"\n[...] Fetching weekly schedule {start_of_week.strftime('%Y-%m-%d')} - {(start_of_week + timedelta(days=4)).strftime('%Y-%m-%d')}...", COLOR_DIM, use_color))
        for day_offset in range(5):
            d = start_of_week + timedelta(days=day_offset)
            try:
                tt = edupage.get_my_timetable(d)
                render_day_timetable(tt, d, use_color=use_color)
            except Exception as e:
                print(colorize(f"[ERR] Day {d} error: {e}", COLOR_RED, use_color))
    else:
        try:
            print(colorize(f"\n[...] Fetching timetable for {target_date.strftime('%Y-%m-%d')}...", COLOR_DIM, use_color))
            tt = edupage.get_my_timetable(target_date)
            render_day_timetable(tt, target_date, use_color=use_color)
        except Exception as e:
            print(colorize(f"[ERR] Failed to fetch timetable: {e}", COLOR_RED, use_color))


# ==============================================================================
# Feature 3: Substitution & Changes (Suplovanie)
# ==============================================================================

def view_substitution(edupage: Edupage, target_date: Optional[date] = None, use_color: bool = True) -> None:
    """Zobrazí chýbajúcich učiteľov a zmeny v rozvrhu (suplovanie) v btop štýle."""
    target_date = target_date or date.today()
    date_str = target_date.strftime("%Y-%m-%d")

    width = 86
    title = f"SUBSTITUTION & TIMETABLE CHANGES [{date_str}]"
    print(colorize(f"\n╭─ {title} {'─' * max(2, width - len(title) - 6)}╮", COLOR_CYAN, use_color))

    try:
        print(colorize("│ [...] Querying substitution endpoints...", COLOR_DIM, use_color))
        missing_teachers = edupage.get_missing_teachers(target_date)
        changes = edupage.get_timetable_changes(target_date)

        # Missing teachers
        print(colorize("├─ ABSENT TEACHERS " + "─" * (width - 21) + "┤", COLOR_CYAN, use_color))
        if missing_teachers:
            names = [colorize(t.name, COLOR_YELLOW, use_color) for t in missing_teachers]
            print("│  " + ", ".join(names))
        else:
            print(colorize("│  [OK] Full staff present. No missing teachers reported.", COLOR_GREEN, use_color))

        # Timetable changes
        print(colorize("├─ LESSON CHANGES & COVER " + "─" * (width - 28) + "┤", COLOR_CYAN, use_color))
        if changes:
            col_class = 12
            col_lesson = 8
            col_desc = 58

            print(f"│  ┌{'─' * (col_class + 2)}┬{'─' * (col_lesson + 2)}┬{'─' * (col_desc + 2)}┐")
            print(f"│  │ {'CLASS':<{col_class}} │ {'PERIOD':<{col_lesson}} │ {'CHANGE / COVER':<{col_desc}} │")
            print(f"│  ├{'─' * (col_class + 2)}┼{'─' * (col_lesson + 2)}┼{'─' * (col_desc + 2)}┤")

            for c in changes:
                cls_str = c.change_class[:col_class]
                lsn_str = str(c.lesson_n)[:col_lesson]
                title_str = c.title[:col_desc]

                print(f"│  │ {cls_str:<{col_class}} │ {lsn_str:<{col_lesson}} │ {colorize(title_str, COLOR_YELLOW, use_color):<{col_desc if not use_color else col_desc + 9}} │")

            print(f"│  └{'─' * (col_class + 2)}┴{'─' * (col_lesson + 2)}┴{'─' * (col_desc + 2)}┘")
        else:
            print(colorize("│  [OK] No changes or substitutions reported.", COLOR_GREEN, use_color))

        print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    except Exception as e:
        print(colorize(f"[ERR] Substitution error: {e}", COLOR_RED, use_color))
    print()


# ==============================================================================
# Feature 4: Lunches & Menu (Obedy)
# ==============================================================================

def render_meal_card(meal: Optional[Meal], title: str, use_color: bool = True) -> None:
    """Vykreslí informácie o konkrétnom jedle (obed/desiata) v btop štýle."""
    if not meal:
        return

    width = 86
    card_title = f"MEAL [{title.upper()}]"
    print(colorize(f"\n╭─ {card_title} {'─' * (width - len(card_title) - 6)}╮", COLOR_CYAN, use_color))

    status_str = f"[ORDERED: {meal.ordered_meal}]" if meal.ordered_meal else "[OFF / NOT ORDERED]"
    status_col = COLOR_GREEN if meal.ordered_meal else COLOR_RED
    print(colorize("│ ", COLOR_CYAN, use_color) + f"STATUS: {colorize(status_str, status_col, use_color)}")

    if meal.served_from and meal.served_to:
        serving_time = f"Serving hours: {meal.served_from.strftime('%H:%M')} - {meal.served_to.strftime('%H:%M')}"
        print(colorize("│ ", COLOR_CYAN, use_color) + colorize(serving_time, COLOR_DIM, use_color))

    if meal.can_be_changed_until:
        deadline = f"Change deadline: {meal.can_be_changed_until.strftime('%Y-%m-%d %H:%M')}"
        print(colorize("│ ", COLOR_CYAN, use_color) + colorize(deadline, COLOR_DIM, use_color))

    div = "─" * (width - 2)
    print(colorize(f"├{div}┤", COLOR_CYAN, use_color))

    if meal.menus:
        for m in meal.menus:
            is_selected = (meal.ordered_meal and meal.ordered_meal == m.number)
            prefix = colorize(">> ", COLOR_GREEN, use_color) if is_selected else "   "
            menu_num = colorize(f"[{m.number}]", COLOR_BOLD, use_color)
            name_str = m.name
            extra = []
            if m.weight:
                extra.append(f"{m.weight}")
            if m.allergens:
                extra.append(f"allergens: {m.allergens}")
            extra_str = f" ({', '.join(extra)})" if extra else ""

            print(colorize("│ ", COLOR_CYAN, use_color) + f"{prefix}{menu_num} {name_str}{colorize(extra_str, COLOR_DIM, use_color)}")
    else:
        print(colorize("│  No menu items listed for this meal.                                       │", COLOR_DIM, use_color))

    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))


def view_lunches(edupage: Edupage, target_date: Optional[date] = None, use_color: bool = True) -> None:
    """Zobrazí jedálny lístok na daný deň v btop štýle."""
    target_date = target_date or date.today()
    date_str = target_date.strftime("%Y-%m-%d")

    width = 86
    title = f"CAFETERIA & MEAL ORDERS [{date_str}]"
    print(colorize(f"\n╭─ {title} {'─' * (width - len(title) - 6)}╮", COLOR_CYAN, use_color))

    try:
        print(colorize("│ [...] Querying cafeteria menu...", COLOR_DIM, use_color))
        meals = edupage.get_meals(target_date)

        if not meals:
            print(colorize("│  No meal records found for this date.                                      │", COLOR_DIM, use_color))
            print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))
            return

        print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

        if meals.snack:
            render_meal_card(meals.snack, "Snack", use_color=use_color)
        if meals.lunch:
            render_meal_card(meals.lunch, "Lunch", use_color=use_color)
        if meals.afternoon_snack:
            render_meal_card(meals.afternoon_snack, "Afternoon Snack", use_color=use_color)

    except Exception as e:
        print(colorize(f"[ERR] Failed to load lunches: {e}", COLOR_RED, use_color))
    print()


# ==============================================================================
# Feature 5: Timeline & Homework (Domáce úlohy a správy)
# ==============================================================================

def view_timeline_and_homework(edupage: Edupage, homework_only: bool = False, use_color: bool = True) -> None:
    """Zobrazí domáce úlohy, písomky a notifikácie v btop štýle."""
    title = "HOMEWORK & EXAMS" if homework_only else "SCHOOL TIMELINE & ANNOUNCEMENTS"
    width = 86
    print(colorize(f"\n╭─ {title} {'─' * (width - len(title) - 6)}╮", COLOR_CYAN, use_color))

    try:
        print(colorize("│ [...] Loading timeline feed...", COLOR_DIM, use_color))
        events = edupage.get_notifications()

        if homework_only:
            hw_types = {
                EventType.HOMEWORK,
                EventType.BIG_EXAM,
                EventType.SHORT_EXAM,
                EventType.ORAL_EXAM,
                EventType.TESTING,
                EventType.PAPER,
            }
            events = [e for e in events if e.event_type in hw_types]

        if not events:
            print(colorize("│  [OK] No pending tasks, exams or notifications.                           │", COLOR_GREEN, use_color))
            print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))
            return

        print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

        for e in events[:20]:
            dt_str = e.timestamp.strftime("%Y-%m-%d %H:%M") if e.timestamp else "-"
            type_label = e.event_type.value if hasattr(e.event_type, "value") else str(e.event_type)

            author_name = e.author.name if hasattr(e.author, "name") else str(e.author or "System")
            deadline_str = f"  |  DEADLINE: {e.event_time.strftime('%Y-%m-%d')}" if e.event_time else ""

            status_str = "[DONE]" if e.is_done else "[PENDING]"
            status_col = COLOR_GREEN if e.is_done else COLOR_YELLOW

            card_head = f"EVENT [{type_label.upper()}]  {dt_str}  from: {author_name}{deadline_str}"
            print(colorize(f"╭─ {card_head}", COLOR_CYAN, use_color))
            print(colorize("│  STATUS: ", COLOR_CYAN, use_color) + colorize(status_str, status_col, use_color))
            text_lines = (e.text or "").split("\n")
            for line in text_lines[:5]:
                print(colorize("│  ", COLOR_CYAN, use_color) + line)
            print(colorize("╰" + "─" * 70, COLOR_CYAN, use_color))

    except Exception as e:
        print(colorize(f"[ERR] Failed to load timeline: {e}", COLOR_RED, use_color))
    print()


# ==============================================================================
# Feature 6: Ringing Times (Zvonenie)
# ==============================================================================

def view_ringing_times(edupage: Edupage, use_color: bool = True) -> None:
    """Zobrazí najbližšie zvonenie a denný rozpis hodín v btop štýle."""
    width = 86
    title = "BELL TIMES & BREAK SCHEDULE"
    print(colorize(f"\n╭─ {title} {'─' * (width - len(title) - 6)}╮", COLOR_CYAN, use_color))
    now = datetime.now()

    try:
        ringing = edupage.get_next_ringing_time(now)
        next_type = "BREAK START (lesson ends)" if ringing.type == RingingType.BREAK else "LESSON START"
        next_time_str = ringing.time.strftime("%H:%M")

        print(colorize("│ ", COLOR_CYAN, use_color) + f"CURRENT TIME: {now.strftime('%H:%M:%S')}")
        print(colorize("│ ", COLOR_CYAN, use_color) + f"NEXT BELL:    {colorize(next_time_str, COLOR_GREEN, use_color)} ({next_type})")

        # Full day ringing schedule from edupage metadata
        if edupage.data and isinstance(edupage.data, dict) and "zvonenia" in edupage.data:
            ringing_times = edupage.data.get("zvonenia", [])
            if ringing_times:
                print(colorize("├─ DAILY RINGING TIMELINE " + "─" * (width - 28) + "┤", COLOR_CYAN, use_color))
                print("│  ┌────────┬─────────────┬──────────────┐")
                print("│  │ PERIOD │ START - END │ DURATION     │")
                print("│  ├────────┼─────────────┼──────────────┤")
                for i, r in enumerate(ringing_times, start=1):
                    start = r.get("starttime", "-")
                    end = r.get("endtime", "-")
                    print(f"│  │ {i:<6} │ {start} - {end:<5} │ 45 min       │")
                print("│  └────────┴─────────────┴──────────────┘")

        print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    except Exception as e:
        print(colorize(f"[ERR] Ringing error: {e}", COLOR_RED, use_color))
    print()


# ==============================================================================
# Feature 7: Directory (Učitelia a trieda)
# ==============================================================================

def view_teachers_directory(edupage: Edupage, query: Optional[str] = None, use_color: bool = True) -> None:
    """Zobrazí zoznam učiteľov školy v btop štýle."""
    width = 86
    title = "STAFF & TEACHER ROSTER"
    print(colorize(f"\n╭─ {title} {'─' * (width - len(title) - 6)}╮", COLOR_CYAN, use_color))

    try:
        print(colorize("│ [...] Loading staff directory...", COLOR_DIM, use_color))
        teachers = edupage.get_teachers()

        if not teachers:
            print(colorize("│  No staff records available.                                              │", COLOR_DIM, use_color))
            print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))
            return

        if query:
            teachers = [t for t in teachers if query.lower() in t.name.lower()]

        teachers_sorted = sorted(teachers, key=lambda t: t.name)
        col_name = 36
        col_room = 24

        print(colorize(f"│  Records matched: {len(teachers_sorted)}", COLOR_DIM, use_color))
        print("│  ┌" + "─" * (col_name + 2) + "┬" + "─" * (col_room + 2) + "┐")
        print(f"│  │ {'NAME':<{col_name}} │ {'ROOM / CABINET':<{col_room}} │")
        print("│  ├" + "─" * (col_name + 2) + "┼" + "─" * (col_room + 2) + "┤")

        for t in teachers_sorted:
            room = t.classroom_name or "-"
            print(f"│  │ {colorize(t.name[:col_name], COLOR_BOLD, use_color):<{col_name if not use_color else col_name + 9}} │ {room[:col_room]:<{col_room}} │")

        print("│  └" + "─" * (col_name + 2) + "┴" + "─" * (col_room + 2) + "┘")
        print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    except Exception as e:
        print(colorize(f"[ERR] Failed to load staff directory: {e}", COLOR_RED, use_color))
    print()


# ==============================================================================
# Interactive Dashboard Main Loop (btop Aesthetic)
# ==============================================================================

def interactive_dashboard(edupage: Edupage, use_color: bool = True) -> None:
    """Hlavná navigačná slučka interaktívneho CLI dashboardu v btop štýle."""
    width = 86

    while True:
        clear_screen()
        print_banner(edupage, use_color=use_color)

        menu_header = f"╭─ MODULES {'─' * (width - 13)}╮"
        print(colorize(menu_header, COLOR_CYAN, use_color))

        def item(key: str, label: str, desc: str) -> None:
            k = colorize(f"[{key}]", COLOR_BOLD, use_color)
            lbl = colorize(f"{label:<14}", COLOR_WHITE, use_color)
            d = colorize(desc, COLOR_DIM, use_color)
            line = f"│  {k} {lbl} {d}"
            print(f"{line:<{width - 2 if not use_color else width + 18}} │")

        item("1", "GRADES", "Marks breakdown, weighted averages & term history")
        item("2", "TIMETABLE", "Daily and weekly schedules, room & teacher cover")
        item("3", "SUBSTITUTION", "Staff absences, timetable changes & cancellations")
        item("4", "LUNCHES", "Daily cafeteria menu, meal status & deadlines")
        item("5", "HOMEWORK", "Upcoming assignments, exams & timeline events")
        item("6", "BELL TIMES", "Ringing schedule, break countdown & periods")
        item("7", "STAFF", "Teacher staff directory & cabinet rooms")
        item("8", "CONFIG", "Session credentials management on this machine")
        item("q", "QUIT", "Terminate session and logout")

        menu_footer = f"╰{'─' * (width - 2)}╯"
        print(colorize(menu_footer, COLOR_CYAN, use_color))
        print()

        prompt_str = colorize("edupage:~$ ", COLOR_BOLD, use_color)
        choice = input(prompt_str).strip().lower()

        if choice in ["0", "q", "exit", "quit"]:
            print(colorize("\n[OK] Logging out. Session ended.", COLOR_DIM, use_color))
            try:
                edupage.logout()
            except Exception:
                pass
            break

        elif choice == "1":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            view_grades(edupage, use_color=use_color)
            input("\n[press Enter to return]")

        elif choice == "2":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            print(colorize("\nTIMETABLE SELECTION:", COLOR_BOLD, use_color))
            print("  [1] Today")
            print("  [2] Tomorrow")
            print("  [3] Current Week (Monday - Friday)")
            print("  [4] Specific Date (YYYY-MM-DD)")
            sub_ch = input("\n  select [1-4, default=1]: ").strip()

            if sub_ch == "2":
                view_timetable(edupage, target_date=date.today() + timedelta(days=1), use_color=use_color)
            elif sub_ch == "3":
                view_timetable(edupage, week_mode=True, use_color=use_color)
            elif sub_ch == "4":
                custom_d = input("  enter date (e.g. 2026-11-25): ").strip()
                try:
                    parsed_d = datetime.strptime(custom_d, "%Y-%m-%d").date()
                    view_timetable(edupage, target_date=parsed_d, use_color=use_color)
                except Exception:
                    print(colorize("  [ERR] Invalid date format.", COLOR_RED, use_color))
            else:
                view_timetable(edupage, target_date=date.today(), use_color=use_color)

            input("\n[press Enter to return]")

        elif choice == "3":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            print(colorize("\nSUBSTITUTION SELECTION:", COLOR_BOLD, use_color))
            print("  [1] Today")
            print("  [2] Tomorrow")
            print("  [3] Specific Date (YYYY-MM-DD)")
            sub_ch = input("\n  select [1-3, default=1]: ").strip()

            if sub_ch == "2":
                view_substitution(edupage, target_date=date.today() + timedelta(days=1), use_color=use_color)
            elif sub_ch == "3":
                custom_d = input("  enter date (e.g. 2026-11-25): ").strip()
                try:
                    parsed_d = datetime.strptime(custom_d, "%Y-%m-%d").date()
                    view_substitution(edupage, target_date=parsed_d, use_color=use_color)
                except Exception:
                    print(colorize("  [ERR] Invalid date format.", COLOR_RED, use_color))
            else:
                view_substitution(edupage, target_date=date.today(), use_color=use_color)

            input("\n[press Enter to return]")

        elif choice == "4":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            print(colorize("\nLUNCHES SELECTION:", COLOR_BOLD, use_color))
            print("  [1] Today")
            print("  [2] Tomorrow")
            print("  [3] Specific Date (YYYY-MM-DD)")
            sub_ch = input("\n  select [1-3, default=1]: ").strip()

            target_d = date.today()
            if sub_ch == "2":
                target_d = date.today() + timedelta(days=1)
            elif sub_ch == "3":
                custom_d = input("  enter date (e.g. 2026-11-25): ").strip()
                try:
                    target_d = datetime.strptime(custom_d, "%Y-%m-%d").date()
                except Exception:
                    print(colorize("  [ERR] Invalid date format.", COLOR_RED, use_color))

            view_lunches(edupage, target_date=target_d, use_color=use_color)
            input("\n[press Enter to return]")

        elif choice == "5":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            print(colorize("\nTIMELINE FILTER:", COLOR_BOLD, use_color))
            print("  [1] Homework & exams only")
            print("  [2] All announcements and events")
            sub_ch = input("\n  select [1-2, default=1]: ").strip()
            hw_only = (sub_ch != "2")
            view_timeline_and_homework(edupage, homework_only=hw_only, use_color=use_color)
            input("\n[press Enter to return]")

        elif choice == "6":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            view_ringing_times(edupage, use_color=use_color)
            input("\n[press Enter to return]")

        elif choice == "7":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            q = input("Search staff by name (Enter for all): ").strip()
            view_teachers_directory(edupage, query=q if q else None, use_color=use_color)
            input("\n[press Enter to return]")

        elif choice == "8":
            clear_screen()
            print_banner(edupage, use_color=use_color)
            print(colorize("\nCREDENTIALS CONFIG:", COLOR_BOLD, use_color))
            print("  [1] Delete stored credentials from this PC")
            print("  [2] Save / update current login credentials")
            sub_ch = input("\n  select [1/2]: ").strip()

            if sub_ch == "1":
                if clear_saved_credentials():
                    print(colorize("  [OK] Saved credentials cleared.", COLOR_GREEN, use_color))
                else:
                    print(colorize("  [i] No stored credentials found.", COLOR_DIM, use_color))
            elif sub_ch == "2":
                pass_input = getpass.getpass("  Confirm password to save: ")
                if pass_input:
                    save_credentials(edupage.username, pass_input, edupage.subdomain)
                    print(colorize("  [OK] Credentials saved successfully.", COLOR_GREEN, use_color))

            input("\n[press Enter to return]")


# ==============================================================================
# CLI Entrypoint (Interactive + Subcommand support)
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(
        prog="edupage-cli",
        description="EduPage CLI - Minimalist btop-style terminal client for EduPage.",
    )
    parser.add_argument(
        "-u",
        "--username",
        type=str,
        default=None,
        help="EduPage username or email.",
    )
    parser.add_argument(
        "-p",
        "--password",
        type=str,
        default=None,
        help="Password (prompted securely if omitted).",
    )
    parser.add_argument(
        "-s",
        "--subdomain",
        type=str,
        default=None,
        help="School subdomain (e.g. 'ssnd' for ssnd.edupage.org).",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output.",
    )

    subparsers = parser.add_subparsers(dest="command", help="Direct non-interactive subcommands:")

    # Command: grades
    p_grades = subparsers.add_parser("grades", help="Show grades overview.")
    p_grades.add_argument("--subject", type=str, default=None, help="Filter by subject.")
    p_grades.add_argument("--json", action="store_true", help="Output raw JSON.")

    # Command: timetable
    p_tt = subparsers.add_parser("timetable", help="Show timetable.")
    p_tt.add_argument("--tomorrow", action="store_true", help="Show tomorrow's schedule.")
    p_tt.add_argument("--week", action="store_true", help="Show entire week.")
    p_tt.add_argument("--date", type=str, default=None, help="Date in YYYY-MM-DD format.")

    # Command: substitution
    p_sub = subparsers.add_parser("substitution", help="Show substitution and missing teachers.")
    p_sub.add_argument("--tomorrow", action="store_true", help="Show tomorrow's substitution.")
    p_sub.add_argument("--date", type=str, default=None, help="Date in YYYY-MM-DD format.")

    # Command: lunches
    p_lunches = subparsers.add_parser("lunches", help="Show cafeteria menu.")
    p_lunches.add_argument("--date", type=str, default=None, help="Date in YYYY-MM-DD format.")

    # Command: homework
    p_hw = subparsers.add_parser("homework", help="Show homework and exams.")

    # Command: ringing
    p_ring = subparsers.add_parser("ringing", help="Show next bell time.")

    # Command: teachers
    p_teach = subparsers.add_parser("teachers", help="Show staff directory.")
    p_teach.add_argument("--query", "-q", type=str, default=None, help="Search staff by name.")

    # Command: logout
    subparsers.add_parser("logout", help="Clear saved credentials.")

    args = parser.parse_args()

    use_color = (not args.no_color and not os.getenv("NO_COLOR") and sys.stdout.isatty())

    # Logout command
    if args.command == "logout":
        if clear_saved_credentials():
            print(colorize("[OK] Stored credentials deleted.", COLOR_GREEN, use_color))
        else:
            print(colorize("[i] No saved credentials found.", COLOR_DIM, use_color))
        sys.exit(0)

    # Login to EduPage
    edupage = authenticate(
        username=args.username,
        password=args.password,
        subdomain=args.subdomain,
        use_color=use_color,
        interactive=(args.command is None),
    )

    if not edupage:
        sys.exit(1)

    try:
        if args.command == "grades":
            view_grades(edupage, use_color=use_color, subject_filter=args.subject)
        elif args.command == "timetable":
            t_date = date.today()
            if args.tomorrow:
                t_date += timedelta(days=1)
            elif args.date:
                t_date = datetime.strptime(args.date, "%Y-%m-%d").date()
            view_timetable(edupage, target_date=t_date, week_mode=args.week, use_color=use_color)
        elif args.command == "substitution":
            t_date = date.today()
            if args.tomorrow:
                t_date += timedelta(days=1)
            elif args.date:
                t_date = datetime.strptime(args.date, "%Y-%m-%d").date()
            view_substitution(edupage, target_date=t_date, use_color=use_color)
        elif args.command == "lunches":
            t_date = date.today()
            if args.date:
                t_date = datetime.strptime(args.date, "%Y-%m-%d").date()
            view_lunches(edupage, target_date=t_date, use_color=use_color)
        elif args.command == "homework":
            view_timeline_and_homework(edupage, homework_only=True, use_color=use_color)
        elif args.command == "ringing":
            view_ringing_times(edupage, use_color=use_color)
        elif args.command == "teachers":
            view_teachers_directory(edupage, query=args.query, use_color=use_color)
        else:
            interactive_dashboard(edupage, use_color=use_color)

    finally:
        try:
            edupage.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main()
