#!/usr/bin/env python3
"""EduPage CLI - Moderný btop-štýl terminálový dashboard pre EduPage."""

import argparse
import getpass
import json
import os
import re
import shutil
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
from edupage_api.grades import EduGrade, EduTextGrade, Grades, Term
from edupage_api.lunches import Meal, Meals, Menu
from edupage_api.people import EduAccount, EduStudent, EduTeacher, People
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

# Configuration file paths and defaults
CONFIG_DIR = os.path.expanduser("~/.edupage")
CONFIG_FILE = os.path.join(CONFIG_DIR, "credentials.json")
LOCAL_CONFIG_FILE = ".edupage_credentials.json"
DEFAULT_SUBDOMAIN = "ssnd"
CLI_VERSION = "v1.2.0"


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


def get_ui_width() -> int:
    """Zistí šírku okna terminálu, ohraničenú na rozsah 88 - 110 znakov."""
    cols, _ = shutil.get_terminal_size((96, 30))
    return max(88, min(cols, 110))


def load_saved_credentials() -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Načíta uložené prihlasovacie údaje s predvolenou subdoménou 'ssnd'."""
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

    subdomain = subdomain or DEFAULT_SUBDOMAIN
    return username, password, subdomain


def save_credentials(username: str, password: Optional[str], subdomain: Optional[str]) -> bool:
    """Automaticky uloží prihlasovacie meno a subdoménu (a prípadne heslo)."""
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        data = {
            "username": username,
            "password": password,
            "subdomain": subdomain or DEFAULT_SUBDOMAIN,
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
    """Prihlási používateľa do EduPage s automatickým zapamätaním mena a ssnd."""
    saved_user, saved_pass, saved_sub = load_saved_credentials()

    username = username or saved_user
    password = password or saved_pass
    subdomain = subdomain or saved_sub or DEFAULT_SUBDOMAIN

    if not username and interactive:
        username = input("Username / Email: ").strip()
        if not username:
            print(colorize("[ERR] Username is required.", COLOR_RED, use_color))
            return None

    if not password and interactive:
        prompt_label = f"Password for {username} ({subdomain}): "
        password = getpass.getpass(prompt_label)
        if not password:
            print(colorize("[ERR] Password is required.", COLOR_RED, use_color))
            return None

    edupage = Edupage()
    if interactive:
        print(colorize(f"[...] Connecting to EduPage [{subdomain}.edupage.org]...", COLOR_DIM, use_color), file=sys.stderr)

    try:
        second_factor = edupage.login(username, password, subdomain)
        if second_factor:
            handle_two_factor(second_factor, edupage, use_color=use_color)

    except BadCredentialsException:
        print(colorize("[ERR] Bad credentials or invalid school subdomain.", COLOR_RED, use_color), file=sys.stderr)
        return None
    except CaptchaException:
        print(colorize("[ERR] Captcha challenge triggered. Log in via web browser first.", COLOR_RED, use_color), file=sys.stderr)
        return None
    except Exception as e:
        print(colorize(f"[ERR] Login failed: {e}", COLOR_RED, use_color), file=sys.stderr)
        return None

    if not edupage.is_logged_in:
        print(colorize("[ERR] Authentication failed.", COLOR_RED, use_color), file=sys.stderr)
        return None

    # Automaticky zapamätať prihlasovacie meno a školu (a uložiť heslo ak je zadané)
    save_credentials(username, password, subdomain)

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
            gn_str = str(grade.grade_n)
            if "/" not in gn_str:
                return f"{gn_str}/{grade.max_points:g} ({grade.percent:.1f}%)"
            return f"{gn_str} ({grade.percent:.1f}%)"
        return f"{grade.percent:.1f}%"
    elif grade.max_points is not None:
        gn_str = str(grade.grade_n)
        if "/" not in gn_str:
            return f"{gn_str}/{grade.max_points:g}"
        return gn_str
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


def parse_slovak_grade(g: EduGrade) -> Optional[float]:
    """Prevedie známku (číslo, percento, body, plus/mínus) na slovenské známkové hodnotenie 1.0 - 5.0."""
    if g.grade_n is not None:
        val_str = str(g.grade_n).strip()
        if val_str.endswith("-"):
            try:
                base = float(val_str[:-1])
                if 1.0 <= base <= 4.0:
                    return base + 0.5
            except ValueError:
                pass
        elif val_str.endswith("+"):
            try:
                base = float(val_str[:-1])
                if 2.0 <= base <= 5.0:
                    return max(1.0, base - 0.25)
            except ValueError:
                pass
        else:
            try:
                num = float(val_str)
                if 1.0 <= num <= 5.0:
                    return num
            except ValueError:
                pass

    pct = g.percent
    if pct is None and g.grade_n is not None:
        s = str(g.grade_n).strip()
        if s.endswith("%"):
            try:
                pct = float(s[:-1])
            except ValueError:
                pass

    if pct is not None and 0.0 <= pct <= 100.0:
        if pct >= 90.0:
            return 1.0
        elif pct >= 75.0:
            return 2.0
        elif pct >= 60.0:
            return 3.0
        elif pct >= 50.0:
            return 4.0
        else:
            return 5.0

    return None


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
            if val_str.endswith("-"):
                num = float(val_str[:-1]) + 0.5
            elif val_str.endswith("+"):
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
    """Zobrazí celoobrazovkovú štruktúrovanú tabuľku známok v btop štýle."""
    total_grades = sum(len(items) for items in grades_by_subject.values())
    total_subjects = len(grades_by_subject)
    width = get_ui_width()

    # Calculate overall GPA across all subjects
    all_grades = [g for glist in grades_by_subject.values() for g in glist]
    overall_stats = calculate_subject_stats(all_grades)
    overall_gpa_str = f"{overall_stats['avg_grade']:.2f}" if overall_stats["avg_grade"] is not None else "-"

    title_text = "EDUPAGE CLI - PREHLAD ZNAMOK"
    stats_text = f"SUBJECTS: {total_subjects}  |  TOTAL MARKS: {total_grades}  |  GPA: {overall_gpa_str}"
    
    print(colorize(f"╭─ {title_text} {'─' * max(2, width - len(title_text) - 6)}╮", COLOR_CYAN, use_color))
    if user_info:
        user_line = f" USER: {user_info}"
        print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f"{user_line:<{width - 4}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color))
    print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f" {stats_text:<{width - 4}}", COLOR_BOLD, use_color) + colorize(" │", COLOR_CYAN, use_color))

    # Summary cards bar for each subject
    subj_badges = []
    for s_name, s_grades in sorted(grades_by_subject.items(), key=lambda x: x[0]):
        s_stats = calculate_subject_stats(s_grades)
        avg_display = f"{s_stats['avg_grade']:.2f}" if s_stats["avg_grade"] is not None else "-"
        s_short = s_name[:10]
        subj_badges.append(f"{s_short}: {avg_display}")
    
    if subj_badges:
        print(colorize(f"├─ SUBJECT SUMMARY " + "─" * (width - 20) + "┤", COLOR_CYAN, use_color))
        # Wrap badges across lines
        current_line = " "
        for b in subj_badges:
            if len(current_line) + len(b) + 3 >= width - 4:
                print(colorize("│", COLOR_CYAN, use_color) + colorize(f"{current_line:<{width - 2}}", COLOR_CYAN, use_color) + colorize("│", COLOR_CYAN, use_color))
                current_line = " " + b + "  "
            else:
                current_line += b + "  "
        if current_line.strip():
            print(colorize("│", COLOR_CYAN, use_color) + colorize(f"{current_line:<{width - 2}}", COLOR_CYAN, use_color) + colorize("│", COLOR_CYAN, use_color))

    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    if not grades_by_subject:
        print(colorize("\n  [i] No grades found for the selected period.\n", COLOR_DIM, use_color))
        return

    col_date = 10
    col_grade = 14
    col_weight = 6
    col_title = max(28, (width - 40) * 5 // 9)
    col_comment = max(20, width - (col_date + col_grade + col_weight + col_title + 16))

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
    """Vykreslí rozvrh na konkrétny deň v btop štýle s indikátorom prebiehajúcej hodiny."""
    sk_days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    day_name = sk_days[target_date.weekday()]
    date_str = f"{day_name} {target_date.strftime('%Y-%m-%d')}"
    width = get_ui_width()
    now_time = datetime.now().time() if target_date == date.today() else None

    print(colorize(f"\n╭─ TIMETABLE [{date_str}] {'─' * max(2, width - len(date_str) - 20)}╮", COLOR_CYAN, use_color))

    if not timetable or not timetable.lessons:
        print(colorize("│  No lessons scheduled for this day.                                         │", COLOR_DIM, use_color))
        print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))
        return

    col_period = 3
    col_time = 13
    col_subject = 22
    col_room = 9
    col_teacher = 15
    col_status = 12
    col_topic = max(16, width - (col_period + col_time + col_subject + col_room + col_teacher + col_status + 20))

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
        + colorize(f"{'STATUS':<{col_status}}", COLOR_DIM, use_color)
        + colorize(" │ ", COLOR_CYAN, use_color)
        + colorize(f"{'CURRICULUM':<{col_topic}}", COLOR_DIM, use_color)
        + colorize(" │", COLOR_CYAN, use_color)
    )
    print(h_row)
    div_row = f"├{'─' * (col_period + 2)}┼{'─' * (col_time + 2)}┼{'─' * (col_subject + 2)}┼{'─' * (col_room + 2)}┼{'─' * (col_teacher + 2)}┼{'─' * (col_status + 2)}┼{'─' * (col_topic + 2)}┤"
    print(colorize(div_row, COLOR_CYAN, use_color))

    sorted_lessons = sorted(
        timetable.lessons,
        key=lambda l: (l.period if l.period is not None else 99, l.start_time or time.min),
    )

    next_found = False
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

        # Calculate status badge
        status_raw = "[OK]"
        status_color = COLOR_GREEN

        if l.is_cancelled:
            status_raw = "[CANCELLED]"
            status_color = COLOR_RED
        elif l.is_event:
            status_raw = "[EVENT]"
            status_color = COLOR_CYAN
        elif l.is_online_lesson():
            status_raw = "[ONLINE]"
            status_color = COLOR_BLUE
        elif now_time and l.start_time and l.end_time:
            if l.start_time <= now_time <= l.end_time:
                status_raw = ">> CURRENT"
                status_color = COLOR_YELLOW
            elif now_time < l.start_time and not next_found:
                status_raw = "> NEXT"
                status_color = COLOR_CYAN
                next_found = True

        status_badge = colorize(f"{status_raw:<{col_status}}", status_color, use_color)

        row = (
            colorize("│ ", COLOR_CYAN, use_color)
            + f"{period_str:<{col_period}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{time_str:<{col_time}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{subj_name:<{col_subject}}", COLOR_BOLD, use_color)
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{room_str:<{col_room}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{teacher_str:<{col_teacher}}"
            + colorize(" │ ", COLOR_CYAN, use_color)
            + status_badge
            + colorize(" │ ", COLOR_CYAN, use_color)
            + f"{topic_str:<{col_topic}}"
            + colorize(" │", COLOR_CYAN, use_color)
        )
        print(row)

    print(colorize(f"╰{'─' * (col_period + 2)}┴{'─' * (col_time + 2)}┴{'─' * (col_subject + 2)}┴{'─' * (col_room + 2)}┴{'─' * (col_teacher + 2)}┴{'─' * (col_status + 2)}┴{'─' * (col_topic + 2)}╯", COLOR_CYAN, use_color))


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
    width = get_ui_width()

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
            col_desc = max(20, width - (col_class + col_lesson + 16))

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

    width = get_ui_width()
    card_title = f"MEAL [{title.upper()}]"
    print(colorize(f"\n╭─ {card_title} {'─' * max(2, width - len(card_title) - 6)}╮", COLOR_CYAN, use_color))

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
    width = get_ui_width()

    title = f"CAFETERIA & MEAL ORDERS [{date_str}]"
    print(colorize(f"\n╭─ {title} {'─' * max(2, width - len(title) - 6)}╮", COLOR_CYAN, use_color))

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
    width = get_ui_width()
    print(colorize(f"\n╭─ {title} {'─' * max(2, width - len(title) - 6)}╮", COLOR_CYAN, use_color))

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
            print(colorize("╰" + "─" * (width - 2), COLOR_CYAN, use_color))

    except Exception as e:
        print(colorize(f"[ERR] Failed to load timeline: {e}", COLOR_RED, use_color))
    print()


# ==============================================================================
# Feature 6: Ringing Times (Zvonenie)
# ==============================================================================

def view_ringing_times(edupage: Edupage, use_color: bool = True) -> None:
    """Zobrazí najbližšie zvonenie a denný rozpis hodín v btop štýle."""
    width = get_ui_width()
    title = "BELL TIMES & BREAK SCHEDULE"
    print(colorize(f"\n╭─ {title} {'─' * max(2, width - len(title) - 6)}╮", COLOR_CYAN, use_color))
    now = datetime.now()

    try:
        ringing = edupage.get_next_ringing_time(now)
        next_type = "BREAK START (lesson ends)" if ringing.type == RingingType.BREAK else "LESSON START"
        next_time_str = ringing.time.strftime("%H:%M")

        print(colorize("│ ", COLOR_CYAN, use_color) + f"CURRENT TIME: {now.strftime('%H:%M:%S')}")
        print(colorize("│ ", COLOR_CYAN, use_color) + f"NEXT BELL:    {colorize(next_time_str, COLOR_GREEN, use_color)} ({next_type})")

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
    width = get_ui_width()
    title = "STAFF & TEACHER ROSTER"
    print(colorize(f"\n╭─ {title} {'─' * max(2, width - len(title) - 6)}╮", COLOR_CYAN, use_color))

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
# BTOP Dashboard: Home Screen Live Panels
# ==============================================================================

def render_home_dashboard(edupage: Edupage, cached_data: Dict[str, Any], use_color: bool = True) -> None:
    """Vykreslí hlavnú domovskú obrazovku s hodinami, rozvrhom, známkami, úlohami a obedom."""
    width = get_ui_width()
    now = datetime.now()
    now_time = now.time()
    last_refresh_str = cached_data.get("refresh_time", now.strftime("%H:%M:%S"))

    # 1. System Header Box
    title_text = f"EDUPAGE MONITOR [{CLI_VERSION}]"
    status_tag = colorize("[ONLINE]", COLOR_GREEN, use_color)
    hdr_top = f"╭─ {colorize(title_text, COLOR_BOLD, use_color)} {'─' * max(2, width - len(title_text) - 16)} {status_tag} ─╮"
    print(colorize(hdr_top, COLOR_CYAN, use_color))

    user_name = get_display_user_name(edupage)
    host = f"{edupage.subdomain}.edupage.org"
    date_display = now.strftime("%Y-%m-%d (%a)").upper()
    time_display = now.strftime("%H:%M:%S")

    next_bell_str = cached_data.get("next_bell", "-")

    line1 = f" USER: {user_name:<20} HOST: {host:<24} DATE: {date_display}"
    line2 = f" TIME: {time_display:<20} NEXT BELL: {next_bell_str:<19} REFRESH: {last_refresh_str}"

    print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f"{line1:<{width - 4}}", COLOR_WHITE, use_color) + colorize(" │", COLOR_CYAN, use_color))
    print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f"{line2:<{width - 4}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color))
    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    # 2. Today's Timetable Box
    tt = cached_data.get("timetable")
    tt_header = f"╭─ TODAY TIMETABLE [{now.strftime('%A').upper()}] {'─' * max(2, width - 30)}╮"
    print(colorize(tt_header, COLOR_CYAN, use_color))

    if tt and tt.lessons:
        col_p = 3
        col_t = 13
        col_s = 20
        col_r = 8
        col_tc = 14
        col_st = 11
        col_tp = max(10, width - (col_p + col_t + col_s + col_r + col_tc + col_st + 20))

        head_row = (
            colorize("│ ", COLOR_CYAN, use_color)
            + colorize(f"{'#':<{col_p}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'TIME':<{col_t}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'SUBJECT':<{col_s}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'ROOM':<{col_r}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'TEACHER':<{col_tc}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'STATUS':<{col_st}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'TOPIC':<{col_tp}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color)
        )
        print(head_row)
        print(colorize(f"├{'─' * (col_p + 2)}┼{'─' * (col_t + 2)}┼{'─' * (col_s + 2)}┼{'─' * (col_r + 2)}┼{'─' * (col_tc + 2)}┼{'─' * (col_st + 2)}┼{'─' * (col_tp + 2)}┤", COLOR_CYAN, use_color))

        sorted_lessons = sorted(tt.lessons, key=lambda l: (l.period if l.period is not None else 99, l.start_time or time.min))
        next_marked = False

        for l in sorted_lessons[:8]:  # Up to 8 lessons on home screen
            p_str = str(l.period) if l.period is not None else "-"
            t_str = f"{l.start_time.strftime('%H:%M')}-{l.end_time.strftime('%H:%M')}" if (l.start_time and l.end_time) else "-"
            s_name = (l.subject.name if l.subject else (l.curriculum if l.is_event else "Free"))[:col_s]
            r_str = (", ".join(c.name for c in l.classrooms) if l.classrooms else "-")[:col_r]
            tc_str = (", ".join(t.name for t in l.teachers) if l.teachers else "-")[:col_tc]
            tp_str = (l.curriculum or "-")[:col_tp]

            st_raw = "[OK]"
            st_col = COLOR_GREEN
            if l.is_cancelled:
                st_raw = "[CANCEL]"
                st_col = COLOR_RED
            elif l.is_event:
                st_raw = "[EVENT]"
                st_col = COLOR_CYAN
            elif l.start_time and l.end_time:
                if l.start_time <= now_time <= l.end_time:
                    st_raw = ">> CURRENT"
                    st_col = COLOR_YELLOW
                elif now_time < l.start_time and not next_marked:
                    st_raw = "> NEXT"
                    st_col = COLOR_CYAN
                    next_marked = True

            st_badge = colorize(f"{st_raw:<{col_st}}", st_col, use_color)

            row = (
                colorize("│ ", COLOR_CYAN, use_color)
                + f"{p_str:<{col_p}}" + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{t_str:<{col_t}}" + colorize(" │ ", COLOR_CYAN, use_color)
                + colorize(f"{s_name:<{col_s}}", COLOR_BOLD, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{r_str:<{col_r}}" + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{tc_str:<{col_tc}}" + colorize(" │ ", COLOR_CYAN, use_color)
                + st_badge + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{tp_str:<{col_tp}}" + colorize(" │", COLOR_CYAN, use_color)
            )
            print(row)
    else:
        print(colorize("│  No lessons scheduled for today.                                            │", COLOR_DIM, use_color))
    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    # 3. Recent Marks Box
    grades = cached_data.get("grades", [])
    gpa_val = cached_data.get("gpa", "-")
    m_head = f"╭─ RECENT MARKS ────────────────────────────────────────── [GPA: {gpa_val} | TOTAL: {len(grades)}] ─╮"
    rem_m = max(2, width - len(m_head) + 8)
    print(colorize(f"╭─ RECENT MARKS {'─' * max(2, width - 40)} [GPA: {gpa_val} | TOTAL: {len(grades)}] ─╮", COLOR_CYAN, use_color))

    if grades:
        col_md = 10
        col_ms = 22
        col_mv = 12
        col_mw = 6
        col_ma = max(18, width - (col_md + col_ms + col_mv + col_mw + 16))

        m_head_row = (
            colorize("│ ", COLOR_CYAN, use_color)
            + colorize(f"{'DATE':<{col_md}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'SUBJECT':<{col_ms}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'MARK':<{col_mv}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'WEIGHT':<{col_mw}}", COLOR_DIM, use_color) + colorize(" │ ", COLOR_CYAN, use_color)
            + colorize(f"{'ASSIGNMENT / NOTE':<{col_ma}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color)
        )
        print(m_head_row)
        print(colorize(f"├{'─' * (col_md + 2)}┼{'─' * (col_ms + 2)}┼{'─' * (col_mv + 2)}┼{'─' * (col_mw + 2)}┼{'─' * (col_ma + 2)}┤", COLOR_CYAN, use_color))

        sorted_recent = sorted(grades, key=lambda g: g.date if g.date else datetime.min, reverse=True)[:5]
        for g in sorted_recent:
            d_str = g.date.strftime("%Y-%m-%d") if g.date else "-"
            sb_str = (g.subject_name or "Unknown")[:col_ms]
            val_str = format_grade_value(g)[:col_mv]
            w_str = format_weight(g)[:col_mw]
            ev_str = (g.title or "-")[:col_ma]

            val_color = get_grade_color(g.grade_n, g.percent)
            val_colored = colorize(f"{val_str:<{col_mv}}", val_color, use_color)

            m_row = (
                colorize("│ ", COLOR_CYAN, use_color)
                + f"{d_str:<{col_md}}" + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{sb_str:<{col_ms}}" + colorize(" │ ", COLOR_CYAN, use_color)
                + val_colored + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{w_str:<{col_mw}}" + colorize(" │ ", COLOR_CYAN, use_color)
                + f"{ev_str:<{col_ma}}" + colorize(" │", COLOR_CYAN, use_color)
            )
            print(m_row)
    else:
        print(colorize("│  No marks recorded.                                                         │", COLOR_DIM, use_color))
    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    # 4. Today's Lunch & Cafeteria Box
    meals = cached_data.get("meals")
    lunch_meal = meals.lunch if (meals and hasattr(meals, "lunch")) else None
    order_status = f"[ORDERED: {lunch_meal.ordered_meal}]" if (lunch_meal and lunch_meal.ordered_meal) else "[OFF / NOT ORDERED]"
    order_col = COLOR_GREEN if (lunch_meal and lunch_meal.ordered_meal) else COLOR_RED

    l_head = f"╭─ TODAY'S LUNCH & CAFETERIA {'─' * max(2, width - 52)} {colorize(order_status, order_col, use_color)} ─╮"
    print(colorize(l_head, COLOR_CYAN, use_color))

    if lunch_meal:
        if lunch_meal.served_from and lunch_meal.served_to:
            serving_info = f" Serving hours: {lunch_meal.served_from.strftime('%H:%M')} - {lunch_meal.served_to.strftime('%H:%M')}"
            print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f"{serving_info:<{width - 4}}", COLOR_DIM, use_color) + colorize(" │", COLOR_CYAN, use_color))
        if lunch_meal.menus:
            for m in lunch_meal.menus:
                is_sel = (lunch_meal.ordered_meal and lunch_meal.ordered_meal == m.number)
                pfx = colorize(">> ", COLOR_GREEN, use_color) if is_sel else "   "
                tag = colorize(f"[{m.number}]", COLOR_BOLD, use_color)
                m_line = f"{pfx}{tag} {m.name}"
                if m.allergens:
                    m_line += colorize(f" (allergens: {m.allergens})", COLOR_DIM, use_color)
                print(colorize("│ ", COLOR_CYAN, use_color) + f"{m_line:<{width - 4 if not use_color else width + 10}}" + colorize(" │", COLOR_CYAN, use_color))
    else:
        print(colorize("│  No cafeteria data available for today.                                     │", COLOR_DIM, use_color))
    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    # 5. Pending Tasks & Deadlines Box
    tasks = cached_data.get("tasks", [])
    t_head = f"╭─ PENDING TASKS & DEADLINES {'─' * max(2, width - 42)} [PENDING: {len(tasks)}] ─╮"
    print(colorize(t_head, COLOR_CYAN, use_color))

    if tasks:
        for t in tasks[:4]:  # Show latest 4 pending tasks
            d_time = f"[{t.event_time.strftime('%Y-%m-%d')}]" if t.event_time else f"[{t.timestamp.strftime('%Y-%m-%d')}]"
            author_name = t.author.name if (hasattr(t.author, "name") and isinstance(t.author.name, str)) else str(t.author or "Teacher")
            t_type = (t.event_type.value if hasattr(t.event_type, "value") else str(t.event_type)).upper()
            txt_clean = (t.text or "").replace("\n", " ")[:width - 35]

            task_line = f"  {colorize(d_time, COLOR_YELLOW, use_color)} {colorize(t_type, COLOR_BOLD, use_color)}: {txt_clean} ({author_name})"
            print(colorize("│", COLOR_CYAN, use_color) + f"{task_line:<{width - 2 if not use_color else width + 12}}" + colorize("│", COLOR_CYAN, use_color))
    else:
        print(colorize("│  [OK] No pending homework or test deadlines.                                │", COLOR_GREEN, use_color))
    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))

    # 6. Bottom Navigation Bar
    nav_line = " [1] GRADES   [2] TIMETABLE   [3] SUBSTITUTION   [4] LUNCHES   [5] TASKS   [r] REFRESH   [q] QUIT"
    print(colorize(f"╭─ COMMANDS {'─' * max(2, width - 13)}╮", COLOR_CYAN, use_color))
    print(colorize("│ ", COLOR_CYAN, use_color) + colorize(f"{nav_line:<{width - 4}}", COLOR_BOLD, use_color) + colorize(" │", COLOR_CYAN, use_color))
    print(colorize(f"╰{'─' * (width - 2)}╯", COLOR_CYAN, use_color))


def fetch_dashboard_cache(edupage: Edupage) -> Dict[str, Any]:
    """Načíta agregované dáta pre domovskú obrazovku."""
    cache: Dict[str, Any] = {
        "refresh_time": datetime.now().strftime("%H:%M:%S"),
        "timetable": None,
        "grades": [],
        "gpa": "-",
        "meals": None,
        "tasks": [],
        "next_bell": "-",
    }

    # 1. Ringing
    try:
        ringing = edupage.get_next_ringing_time(datetime.now())
        r_type = "BREAK" if ringing.type == RingingType.BREAK else "LESSON"
        cache["next_bell"] = f"{ringing.time.strftime('%H:%M')} [{r_type}]"
    except Exception:
        pass

    # 2. Timetable
    try:
        cache["timetable"] = edupage.get_my_timetable(date.today())
    except Exception:
        pass

    # 3. Grades
    try:
        grades = edupage.get_grades()
        cache["grades"] = grades
        stats = calculate_subject_stats(grades)
        if stats["avg_grade"] is not None:
            cache["gpa"] = f"{stats['avg_grade']:.2f}"
    except Exception:
        pass

    # 4. Meals
    try:
        cache["meals"] = edupage.get_meals(date.today())
    except Exception:
        pass

    # 5. Tasks & homework
    try:
        events = edupage.get_notifications()
        hw_types = {
            EventType.HOMEWORK,
            EventType.BIG_EXAM,
            EventType.SHORT_EXAM,
            EventType.ORAL_EXAM,
            EventType.TESTING,
            EventType.PAPER,
        }
        pending_hw = [e for e in events if e.event_type in hw_types and not e.is_done]
        cache["tasks"] = pending_hw
    except Exception:
        pass

    return cache


def _hhmm_to_sec(hhmm: Optional[str]) -> Optional[int]:
    """Prevedie reťazec HH:MM na sekundy od polnoci."""
    if not hhmm or ":" not in str(hhmm):
        return None
    try:
        parts = str(hhmm).strip().split(":")
        return int(parts[0]) * 3600 + int(parts[1]) * 60
    except Exception:
        return None


def _extract_periods_and_breaks(dbi: dict) -> Tuple[List[dict], List[dict], Dict[str, dict]]:
    """Extrahuje zvonenia pre hodiny 1-8 a prestávky medzi nimi."""
    default_periods = [
        {"period": "1", "start": "07:55", "end": "08:40"},
        {"period": "2", "start": "08:45", "end": "09:30"},
        {"period": "3", "start": "09:40", "end": "10:25"},
        {"period": "4", "start": "10:40", "end": "11:25"},
        {"period": "5", "start": "11:30", "end": "12:15"},
        {"period": "6", "start": "12:20", "end": "13:05"},
        {"period": "7", "start": "13:35", "end": "14:20"},
        {"period": "8", "start": "14:25", "end": "15:10"},
    ]

    raw_periods = dbi.get("periods") or []
    raw_by_p: Dict[str, dict] = {}
    for p in raw_periods:
        p_id = str(p.get("short") or p.get("id") or "").strip()
        if p_id.isdigit() and 1 <= int(p_id) <= 8 and p.get("starttime") and p.get("endtime"):
            raw_by_p[p_id] = {
                "period": p_id,
                "start": p["starttime"],
                "end": p["endtime"],
            }

    periods_schedule: List[dict] = []
    period_by_num: Dict[str, dict] = {}
    for dp in default_periods:
        p_num = dp["period"]
        src = raw_by_p.get(p_num, dp)
        s_sec = _hhmm_to_sec(src["start"])
        e_sec = _hhmm_to_sec(src["end"])
        entry = {
            "period": p_num,
            "start": src["start"],
            "end": src["end"],
            "start_sec": s_sec,
            "end_sec": e_sec,
        }
        periods_schedule.append(entry)
        period_by_num[p_num] = entry

    breaks_schedule: List[dict] = []
    for idx in range(len(periods_schedule) - 1):
        cur_p = periods_schedule[idx]
        nxt_p = periods_schedule[idx + 1]
        b_start_sec = cur_p["end_sec"]
        b_end_sec = nxt_p["start_sec"]
        dur_min = (b_end_sec - b_start_sec) // 60 if (b_start_sec is not None and b_end_sec is not None) else 0
        if dur_min >= 25:
            b_name = "Obedná prestávka"
        elif dur_min >= 15:
            b_name = "Veľká prestávka"
        elif dur_min >= 10:
            b_name = "Desiatová prestávka"
        else:
            b_name = "Malá prestávka"

        breaks_schedule.append({
            "id": f"{cur_p['period']}-{nxt_p['period']}",
            "after_period": cur_p["period"],
            "before_period": nxt_p["period"],
            "between": f"{cur_p['period']}. ➔ {nxt_p['period']}. hodina",
            "start": cur_p["end"],
            "end": nxt_p["start"],
            "start_sec": b_start_sec,
            "end_sec": b_end_sec,
            "duration_min": dur_min,
            "name": b_name,
        })

    return periods_schedule, breaks_schedule, period_by_num


def _format_teacher_info(teacher_row: Optional[dict]) -> Tuple[str, str, str]:
    """Vráti (celé meno, skrátené meno 'M. Priezvisko', kód učiteľa)."""
    if not teacher_row:
        return "-", "-", ""
    code = str(teacher_row.get("short") or "").strip()
    fn = str(teacher_row.get("firstname") or "").strip()
    ln = str(teacher_row.get("lastname") or "").strip()
    if fn or ln:
        full = f"{fn} {ln}".strip()
        short_name = f"{fn[0]}. {ln}".strip() if fn else ln
        return full, short_name, code

    raw_name = str(teacher_row.get("name") or "").strip()
    if "," in raw_name:
        parts = raw_name.split(",", 1)
        ln = parts[0].strip()
        fn = parts[1].strip()
        full = f"{fn} {ln}".strip()
        short_name = f"{fn[0]}. {ln}".strip() if fn else ln
        return full, short_name, code
    if raw_name:
        return raw_name, raw_name, code
    return "-", "-", code


def _format_room_info(room_row: Optional[dict], class_name: str) -> Tuple[str, str]:
    """Vráti (celý názov učebne, stručný kód/číslo učebne)."""
    if not room_row:
        return "-", "-"
    full = str(room_row.get("name") or "").strip() or "-"
    r_short = str(room_row.get("short") or "").strip()
    clean_cls = class_name.replace(".", "").upper()
    if r_short and r_short.replace(".", "").upper() != clean_cls:
        return full, r_short
    m = re.match(r"^\((\d+)\)", full)
    if m:
        return full, m.group(1)
    return full, (r_short or full)


def _build_lesson_entry(
    period_str: str,
    start_str: str,
    end_str: str,
    subj_row: Optional[dict],
    event_name: str,
    class_ids: List[str],
    group_names: List[str],
    teacher_ids: List[str],
    classroom_ids: List[str],
    student_class_id: Optional[str],
    subjects_map: dict,
    teachers_map: dict,
    classrooms_map: dict,
    classes_map: dict,
    is_cancelled: bool = False,
    is_changed: bool = False,
    is_event: bool = False,
    status: str = "PLÁN",
    topic: str = "-",
) -> dict:
    """Vytvorí jednotný slovník pre hodinu v aktuálnom aj stacionárnom rozvrhu."""
    t_str = f"{start_str}-{end_str}" if (start_str and end_str) else "-"
    start_s = _hhmm_to_sec(start_str)
    end_s = _hhmm_to_sec(end_str)

    if subj_row:
        raw_s_name = str(subj_row.get("name") or "").strip() or "Predmet"
        raw_s_short = str(subj_row.get("short") or "").strip() or raw_s_name[:4].upper()
    elif is_event or event_name:
        raw_s_name = event_name or "Školská udalosť"
        raw_s_short = "UDAL"
    else:
        raw_s_name = "Voľná hodina"
        raw_s_short = "VOĽN"

    clean_groups = [str(g).strip() for g in (group_names or []) if str(g).strip()]
    group_str = ", ".join(clean_groups)
    subj_display = f"{raw_s_name} ({group_str})" if group_str else raw_s_name

    # Class resolution (prefer student's own class if shared lesson)
    cls_names = []
    if student_class_id and str(student_class_id) in [str(c) for c in (class_ids or [])]:
        c_row = classes_map.get(str(student_class_id))
        if c_row and c_row.get("name"):
            cls_names.append(str(c_row["name"]))
    if not cls_names:
        for cid in (class_ids or [])[:2]:
            c_row = classes_map.get(str(cid))
            if c_row and c_row.get("name"):
                cls_names.append(str(c_row["name"]))
    class_name = ", ".join(cls_names) if cls_names else "-"

    # Teachers
    tc_full_list, tc_short_list, tc_code_list = [], [], []
    for tid in teacher_ids or []:
        full_t, short_t, code_t = _format_teacher_info(teachers_map.get(str(tid)))
        if full_t != "-":
            tc_full_list.append(full_t)
            tc_short_list.append(short_t)
            if code_t:
                tc_code_list.append(code_t)
    teacher_full = ", ".join(tc_full_list) if tc_full_list else "-"
    teacher_short = ", ".join(tc_short_list) if tc_short_list else "-"
    teacher_code = "/".join(tc_code_list) if tc_code_list else ""

    # Classrooms
    rm_full_list, rm_short_list = [], []
    for r_id in classroom_ids or []:
        full_r, short_r = _format_room_info(classrooms_map.get(str(r_id)), class_name)
        if full_r != "-":
            rm_full_list.append(full_r)
            rm_short_list.append(short_r)
    room_full = ", ".join(rm_full_list) if rm_full_list else "-"
    room_short = ", ".join(rm_short_list) if rm_short_list else "-"

    return {
        "period": period_str,
        "time": t_str,
        "start": start_str,
        "end": end_str,
        "start_sec": start_s,
        "end_sec": end_s,
        "subject_short": raw_s_short,
        "subject": subj_display,
        "class_name": class_name,
        "group": group_str,
        "room": room_full,
        "room_short": room_short,
        "teacher": teacher_full,
        "teacher_short": teacher_short,
        "teacher_code": teacher_code,
        "status": status,
        "is_cancelled": is_cancelled,
        "is_changed": is_changed,
        "is_event": is_event,
        "topic": topic or "-",
    }


def _fetch_actual_week_timetable(
    edupage: Edupage,
    student_id: Optional[str],
    student_class_id: Optional[str],
    monday: date,
    today: date,
    period_by_num: Dict[str, dict],
    dbi: dict,
) -> dict:
    """Načíta aktuálny rozvrh (vrátane zmien, suplovaní a odpadnutí) pre Po-Pi jedným dopytom."""
    day_names_sk = ["Pondelok", "Utorok", "Streda", "Štvrtok", "Piatok"]
    subjects_map = dbi.get("subjects", {})
    teachers_map = dbi.get("teachers", {})
    classrooms_map = dbi.get("classrooms", {})
    classes_map = dbi.get("classes", {})

    by_date: Dict[str, list] = {}
    if student_id:
        try:
            year = edupage.data.get("dp", {}).get("year") or today.year
            friday = monday + timedelta(days=4)
            url = f"https://{edupage.subdomain}.edupage.org/timetable/server/currenttt.js?__func=curentttGetData"
            payload = {
                "__args": [
                    None,
                    {
                        "year": year,
                        "datefrom": monday.strftime("%Y-%m-%d"),
                        "dateto": friday.strftime("%Y-%m-%d"),
                        "table": "students",
                        "id": str(student_id),
                        "showColors": True,
                        "showIgroupsInClasses": True,
                        "showOrig": True,
                        "log_module": "CurrentTTView",
                    },
                ],
                "__gsh": edupage.gsec_hash,
            }
            resp = edupage.session.post(url, json=payload, timeout=15).json()
            for it in resp.get("r", {}).get("ttitems", []) or []:
                d_key = it.get("date")
                if d_key:
                    by_date.setdefault(d_key, []).append(it)
        except Exception:
            by_date = {}

    week_days: dict = {}
    for idx in range(5):
        cur_d = monday + timedelta(days=idx)
        d_str = cur_d.strftime("%Y-%m-%d")
        raw_items = by_date.get(d_str, [])
        slot_entries: Dict[str, List[dict]] = {}

        for it in raw_items:
            p_raw = str(it.get("uniperiod") or "").strip()
            if not p_raw.isdigit():
                continue
            p_num = int(p_raw)
            dur = max(1, int(it.get("durationperiods") or 1))
            is_cancelled = bool(it.get("removed") or it.get("type") in ("absent", ""))
            is_changed = bool(it.get("changed"))
            is_event = bool(it.get("type") in ("event", "out") or it.get("main"))

            subj_id = str(it.get("subjectid") or "").strip()
            subj_row = subjects_map.get(subj_id) if subj_id else None
            ev_name = ""
            try:
                ev_name = str(it.get("name") or (it.get("flags") or {}).get("event", {}).get("name") or "").strip()
            except Exception:
                ev_name = str(it.get("name") or "").strip()
            if not subj_row and not ev_name and is_cancelled:
                continue

            try:
                note_wd = (it.get("flags") or {}).get("dp0", {}).get("note_wd")
            except Exception:
                note_wd = None
            topic_str = str(note_wd or ev_name or "-").strip() or "-"

            if is_cancelled:
                st_str = "ODPADLA"
            elif is_event:
                st_str = "UDALOSŤ"
            elif is_changed:
                st_str = "ZMENA"
            else:
                st_str = "PLÁN"

            for offset in range(dur):
                slot_p = p_num + offset
                if slot_p < 1 or slot_p > 8:
                    continue
                slot_key = str(slot_p)
                p_def = period_by_num.get(slot_key, {})
                s_time = p_def.get("start") or str(it.get("starttime") or "")
                e_time = p_def.get("end") or str(it.get("endtime") or "")
                if dur == 1 and it.get("starttime") and it.get("endtime"):
                    s_time = str(it.get("starttime"))
                    e_time = str(it.get("endtime"))

                entry = _build_lesson_entry(
                    period_str=slot_key,
                    start_str=s_time,
                    end_str=e_time,
                    subj_row=subj_row,
                    event_name=ev_name,
                    class_ids=it.get("classids") or [],
                    group_names=it.get("groupnames") or [],
                    teacher_ids=it.get("teacherids") or [],
                    classroom_ids=it.get("classroomids") or [],
                    student_class_id=student_class_id,
                    subjects_map=subjects_map,
                    teachers_map=teachers_map,
                    classrooms_map=classrooms_map,
                    classes_map=classes_map,
                    is_cancelled=is_cancelled,
                    is_changed=is_changed,
                    is_event=is_event,
                    status=st_str,
                    topic=topic_str,
                )
                slot_entries.setdefault(slot_key, []).append(entry)

        day_lessons: List[dict] = []
        for slot_key in sorted(slot_entries.keys(), key=lambda x: int(x)):
            candidates = slot_entries[slot_key]
            # Prefer non-cancelled entries (e.g. replacement lesson or event) over removed placeholders
            active = [c for c in candidates if not c["is_cancelled"]]
            chosen = active[0] if active else candidates[0]
            day_lessons.append(chosen)

        week_days[d_str] = {
            "day_name": day_names_sk[idx],
            "date": d_str,
            "is_today": (cur_d == today),
            "lessons": day_lessons,
        }

    return week_days


def _build_regular_week_timetable(
    edupage: Edupage,
    student_id: Optional[str],
    student_class_id: Optional[str],
    monday: date,
    today: date,
    period_by_num: Dict[str, dict],
    fallback_week: dict,
) -> dict:
    """Načíta stacionárny (stály) rozvrh z regularttGetData bez dočasných zmien a odpadnutí."""
    day_names_sk = ["Pondelok", "Utorok", "Streda", "Štvrtok", "Piatok"]
    try:
        year = edupage.data.get("dp", {}).get("year") or today.year
        tt_num = "130"
        try:
            url_viewer = f"https://{edupage.subdomain}.edupage.org/timetable/server/ttviewer.js?__func=getTTViewerData"
            v_resp = edupage.session.post(url_viewer, json={"__args": [None, year], "__gsh": edupage.gsec_hash}, timeout=10).json()
            reg_num = v_resp.get("r", {}).get("regular", {}).get("default_num")
            if reg_num:
                tt_num = str(reg_num)
        except Exception:
            pass

        url_reg = f"https://{edupage.subdomain}.edupage.org/timetable/server/regulartt.js?__func=regularttGetData"
        r_resp = edupage.session.post(url_reg, json={"__args": [None, tt_num], "__gsh": edupage.gsec_hash}, timeout=15).json()
        dbi_res = r_resp.get("r", {}).get("dbiAccessorRes", {})
        tables = {t["id"]: t.get("data_rows", []) for t in dbi_res.get("tables", [])}

        subjects_map = {str(r["id"]): r for r in tables.get("subjects", [])}
        teachers_map = {str(r["id"]): r for r in tables.get("teachers", [])}
        classrooms_map = {str(r["id"]): r for r in tables.get("classrooms", [])}
        classes_map = {str(r["id"]): r for r in tables.get("classes", [])}
        groups_map = {str(r["id"]): r for r in tables.get("groups", [])}

        my_lessons = {
            str(r["id"]): r
            for r in tables.get("lessons", [])
            if student_id and str(student_id) in [str(sid) for sid in (r.get("studentids") or [])]
        }

        if not my_lessons:
            raise ValueError("No regular lessons found for student")

        regular_days: dict = {}
        for d_idx in range(5):
            cur_d = monday + timedelta(days=d_idx)
            d_str = cur_d.strftime("%Y-%m-%d")
            slot_entries: Dict[str, dict] = {}

            for card in tables.get("cards", []):
                lid = str(card.get("lessonid") or "")
                days_mask = str(card.get("days") or "")
                if lid not in my_lessons or len(days_mask) <= d_idx or days_mask[d_idx] != "1":
                    continue

                p_raw = str(card.get("period") or "").strip()
                if not p_raw.isdigit():
                    continue
                p_num = int(p_raw)
                les = my_lessons[lid]
                subj_row = subjects_map.get(str(les.get("subjectid") or ""))

                grp_names = []
                for gid in les.get("groupids") or []:
                    g_row = groups_map.get(str(gid))
                    if g_row and not g_row.get("entireclass") and g_row.get("name"):
                        grp_names.append(str(g_row["name"]))

                # Cards in regulartt are typically 1 per period slot, or multi-period; support both safely
                dur = 1
                if int(les.get("durationperiods") or 1) > 1:
                    # Only expand if there isn't already another card for this same lesson on p_num + 1
                    has_next_card = any(
                        str(c2.get("lessonid") or "") == lid
                        and len(str(c2.get("days") or "")) > d_idx
                        and str(c2.get("days"))[d_idx] == "1"
                        and str(c2.get("period") or "") == str(p_num + 1)
                        for c2 in tables.get("cards", [])
                    )
                    if not has_next_card:
                        dur = int(les.get("durationperiods") or 1)

                for offset in range(dur):
                    slot_p = p_num + offset
                    if slot_p < 1 or slot_p > 8:
                        continue
                    slot_key = str(slot_p)
                    if slot_key in slot_entries:
                        continue
                    p_def = period_by_num.get(slot_key, {})
                    slot_entries[slot_key] = _build_lesson_entry(
                        period_str=slot_key,
                        start_str=p_def.get("start", ""),
                        end_str=p_def.get("end", ""),
                        subj_row=subj_row,
                        event_name="",
                        class_ids=les.get("classids") or [],
                        group_names=grp_names,
                        teacher_ids=les.get("teacherids") or [],
                        classroom_ids=card.get("classroomids") or [],
                        student_class_id=student_class_id,
                        subjects_map=subjects_map,
                        teachers_map=teachers_map,
                        classrooms_map=classrooms_map,
                        classes_map=classes_map,
                        is_cancelled=False,
                        is_changed=False,
                        is_event=False,
                        status="STÁLY",
                        topic="-",
                    )

            day_lessons = [slot_entries[k] for k in sorted(slot_entries.keys(), key=lambda x: int(x))]
            regular_days[d_str] = {
                "day_name": day_names_sk[d_idx],
                "date": d_str,
                "is_today": (cur_d == today),
                "lessons": day_lessons,
            }

        return regular_days
    except Exception:
        # Fallback built from actual week timetable without temporary events/cancellations
        reg_fallback: dict = {}
        for d_str, d_info in fallback_week.items():
            clean_lessons = []
            for l in d_info.get("lessons", []):
                if l.get("is_event"):
                    continue
                copy_l = dict(l)
                copy_l["is_cancelled"] = False
                copy_l["is_changed"] = False
                copy_l["status"] = "STÁLY"
                clean_lessons.append(copy_l)
            reg_fallback[d_str] = {
                "day_name": d_info.get("day_name", ""),
                "date": d_str,
                "is_today": d_info.get("is_today", False),
                "lessons": clean_lessons,
            }
        return reg_fallback


def export_dashboard_json(edupage: Edupage) -> dict:
    """Vráti kompletné agregované JSON dáta pre Node.js TUI dashboard s grafmi."""
    now = datetime.now()
    now_time = now.time()
    dbi = edupage.data.get("dbi", {}) if hasattr(edupage, "data") and edupage.data else {}
    periods_schedule, breaks_schedule, period_by_num = _extract_periods_and_breaks(dbi)

    data: Dict[str, Any] = {
        "user": get_display_user_name(edupage),
        "username": edupage.username,
        "subdomain": edupage.subdomain or "ssnd",
        "school": f"{edupage.subdomain or 'ssnd'}.edupage.org",
        "date": now.strftime("%Y-%m-%d (%a)").upper(),
        "time": now.strftime("%H:%M:%S"),
        "next_bell": "-",
        "lesson_progress": 0,
        "gpa": "-",
        "standing": "-",
        "total_marks": 0,
        "trend": {"x": [], "y": []},
        "distribution": {"titles": ["1", "2", "3", "4", "5"], "data": [0, 0, 0, 0, 0]},
        "subjects": [],
        "timetable": [],
        "periods_schedule": periods_schedule,
        "breaks_schedule": breaks_schedule,
        "week_timetable": {},
        "regular_week_timetable": {},
        "lunches": None,
        "tasks": [],
        "all_grades": [],
        "commendations": [],
    }

    # 1. Ringing
    try:
        ringing = edupage.get_next_ringing_time(now)
        r_type = "BREAK" if ringing.type == RingingType.BREAK else "LESSON"
        data["next_bell"] = f"{ringing.time.strftime('%H:%M')} [{r_type}]"
    except Exception:
        pass

    # 2. Timetable (Monitor today's list + Full Week Actual + Full Week Stationary)
    try:
        user_id = edupage.get_user_id()
        student_id = user_id.replace("Student", "") if (user_id and user_id.startswith("Student")) else None
        student_obj = People(edupage).get_student(student_id) if student_id else None
        student_class_id = None
        if student_id and str(student_id) in (dbi.get("students") or {}):
            student_class_id = str(dbi["students"][str(student_id)].get("classid") or "")

        today = date.today()
        monday = today - timedelta(days=today.weekday())

        week_days = _fetch_actual_week_timetable(
            edupage=edupage,
            student_id=student_id,
            student_class_id=student_class_id,
            monday=monday,
            today=today,
            period_by_num=period_by_num,
            dbi=dbi,
        )
        data["week_timetable"] = week_days

        data["regular_week_timetable"] = _build_regular_week_timetable(
            edupage=edupage,
            student_id=student_id,
            student_class_id=student_class_id,
            monday=monday,
            today=today,
            period_by_num=period_by_num,
            fallback_week=week_days,
        )

        # Build today's timetable for Monitor tab (with free period 1 indicator if applicable)
        tt = edupage.get_timetable(student_obj, today) if student_obj else edupage.get_my_timetable(today)
        if tt and tt.lessons:
            sorted_lessons = sorted(
                tt.lessons,
                key=lambda l: (l.period if l.period is not None else 99, l.start_time or time.min),
            )

            valid_active = [l for l in sorted_lessons if (l.subject is not None or l.is_event) and not l.is_cancelled]
            if valid_active and valid_active[0].period is not None and valid_active[0].period > 1:
                first_p = valid_active[0].period
                p1 = period_by_num.get("1", {"start": "07:55", "end": "08:40", "start_sec": 28500, "end_sec": 31200})
                data["timetable"].append({
                    "period": "1",
                    "time": f"{p1['start']}-{p1['end']}",
                    "start": p1["start"],
                    "end": p1["end"],
                    "start_sec": p1["start_sec"],
                    "end_sec": p1["end_sec"],
                    "subject": "Voľná hodina",
                    "room": "-",
                    "teacher": "-",
                    "status": "VOĽNO",
                    "topic": f"Začiatok vyučovania {first_p}. hodinou",
                })

            next_found = False
            for l in sorted_lessons:
                if l.subject is None and (l.is_cancelled or not l.start_time):
                    continue

                p_str = str(l.period) if l.period is not None else "-"
                t_str = f"{l.start_time.strftime('%H:%M')}-{l.end_time.strftime('%H:%M')}" if (l.start_time and l.end_time) else "-"
                s_name = l.subject.name if l.subject else (l.curriculum if l.is_event else "Voľná hodina")
                if l.groups:
                    group_str = ", ".join(l.groups)
                    s_name = f"{s_name} ({group_str})"

                r_str = ", ".join(c.name for c in l.classrooms) if l.classrooms else "-"
                tc_str = ", ".join(t.name for t in l.teachers) if l.teachers else "-"
                topic_str = l.curriculum or "-"

                start_s = (l.start_time.hour * 3600 + l.start_time.minute * 60) if l.start_time else None
                end_s = (l.end_time.hour * 3600 + l.end_time.minute * 60) if l.end_time else None

                status_str = "PLÁN"
                if l.is_cancelled:
                    status_str = "ODPADLA"
                elif l.is_event:
                    status_str = "UDALOSŤ"
                elif l.start_time and l.end_time:
                    if l.start_time <= now_time <= l.end_time:
                        status_str = "CURRENT"
                        total_secs = (datetime.combine(today, l.end_time) - datetime.combine(today, l.start_time)).total_seconds()
                        elapsed_secs = (datetime.combine(today, now_time) - datetime.combine(today, l.start_time)).total_seconds()
                        if total_secs > 0:
                            data["lesson_progress"] = max(0, min(100, int(elapsed_secs / total_secs * 100)))
                    elif now_time > l.end_time:
                        status_str = "DONE"
                    elif now_time < l.start_time and not next_found:
                        status_str = "NEXT"
                        next_found = True

                data["timetable"].append({
                    "period": p_str,
                    "time": t_str,
                    "start": l.start_time.strftime("%H:%M") if l.start_time else None,
                    "end": l.end_time.strftime("%H:%M") if l.end_time else None,
                    "start_sec": start_s,
                    "end_sec": end_s,
                    "subject": s_name,
                    "room": r_str,
                    "teacher": tc_str,
                    "status": status_str,
                    "topic": topic_str,
                })
    except Exception:
        pass

    # 3. Grades, Subject Breakdowns & Commendations (Pochvaly / Poznámky)
    try:
        grades = edupage.get_grades()
        data["total_marks"] = len(grades)
        dbi_subjects = dbi.get("subjects", {}) if isinstance(dbi, dict) else {}

        # Extract Pochvaly / Poznámky from vsetkyVcelicky + typyPoznamok
        try:
            raw_gd = Grades(edupage)._Grades__get_grade_data()
            type_map: Dict[str, dict] = {}
            for tp in raw_gd.get("typyPoznamok", []) or []:
                tid = str(tp.get("id") if tp.get("id") is not None else "").strip()
                if tid:
                    type_map[tid] = tp

            for vc in raw_gd.get("vsetkyVcelicky", []) or []:
                p_typ = str(vc.get("p_typ") if vc.get("p_typ") is not None else "").strip()
                tp_info = type_map.get(p_typ, {})
                pos = int(tp_info.get("positivity") or 0)
                if pos == 0:
                    if p_typ in ("1", "3", "4", "6", "7", "8", "9", "10", "11", "medal", "key"):
                        pos = 1
                    elif p_typ in ("2", "5", "12", "13", "14", "minus", "slippers", "mobile", "clock", "backpack"):
                        pos = -1

                cat = "POCHVALA" if pos > 0 else ("POZNÁMKA" if pos < 0 else "ZÁZNAM")
                t_label = str(tp_info.get("nazov") or "").strip()
                if not t_label:
                    t_label = "Pochvala" if pos > 0 else ("Poznámka / Pokarhanie" if pos < 0 else "Výchovný záznam")

                raw_dt = str(vc.get("p_datum") or vc.get("timestamp") or "-").strip()
                dt_short = raw_dt[:16] if len(raw_dt) >= 16 else raw_dt
                subj_vc = str(vc.get("predmet_meno") or "Správanie").strip()
                tc_vc = f"{vc.get('ucitel_meno') or ''} {vc.get('ucitel_priezvisko') or ''}".strip() or "-"
                st_vc = "Potvrdené rodičom" if vc.get("p_datum_view_rodic") else (
                    "Schválené" if vc.get("schvalene_stav") == "schvalene" else "Zapísané"
                )
                txt_vc = str(vc.get("p_text") or "-").replace("\n", " ").strip()

                data["commendations"].append({
                    "id": str(vc.get("VcelickaID") or ""),
                    "date": dt_short,
                    "category": cat,
                    "type_name": t_label,
                    "subject": subj_vc,
                    "teacher": tc_vc,
                    "state": st_vc,
                    "text": txt_vc,
                })
        except Exception:
            pass

        # Process ALL grades for distribution so nothing is skipped
        dist = [0, 0, 0, 0, 0]
        for g in grades:
            num = parse_slovak_grade(g)
            if num is not None and 1.0 <= num <= 5.0:
                dist[min(4, max(0, int(round(num)) - 1))] += 1

        data["distribution"] = {
            "titles": ["1", "2", "3", "4", "5"],
            "data": dist,
            "labels": ["Výborný", "Chválitebný", "Dobrý", "Dostatočný", "Nedostatočný"],
            "total": sum(dist),
        }

        chronological_grades = sorted([g for g in grades if g.date], key=lambda g: g.date)
        cum_weighted_sum = 0.0
        cum_weight_total = 0.0
        trend_x = []
        trend_y = []

        for g in chronological_grades:
            num = parse_slovak_grade(g)
            if num is not None and 1.0 <= num <= 5.0:
                w = g.importance if (g.importance and g.importance > 0) else 1.0
                cum_weighted_sum += num * w
                cum_weight_total += w
                curr_gpa = round(cum_weighted_sum / cum_weight_total, 2)
                trend_x.append(g.date.strftime("%d.%m"))
                trend_y.append(curr_gpa)

        if len(trend_x) > 10:
            step = (len(trend_x) - 1) / 9
            sampled_indices = [int(i * step) for i in range(10)]
            trend_x = [trend_x[i] for i in sampled_indices]
            trend_y = [trend_y[i] for i in sampled_indices]
        data["trend"]["x"] = trend_x
        data["trend"]["y"] = trend_y

        by_subj: Dict[str, list] = {}
        for g in grades:
            by_subj.setdefault(g.subject_name or "Unknown", []).append(g)

        teacher_by_short: Dict[str, str] = {}
        for wk_src in (data.get("regular_week_timetable") or {}, data.get("week_timetable") or {}):
            for d_obj in wk_src.values():
                for les in d_obj.get("lessons", []) or []:
                    s_sh = str(les.get("subject_short") or "").strip()
                    t_fl = str(les.get("teacher") or "").strip()
                    if s_sh and t_fl and t_fl != "-" and s_sh not in teacher_by_short:
                        teacher_by_short[s_sh] = t_fl

        verbal_names = ["Výborný", "Chválitebný", "Dobrý", "Dostatočný", "Nedostatočný"]
        subject_averages = []
        for s_name, glist in sorted(by_subj.items(), key=lambda x: x[0]):
            s_stat = calculate_subject_stats(glist)
            subj_avg = None
            if s_stat["avg_grade"] is not None:
                subj_avg = s_stat["avg_grade"]
                avg_display = f"{subj_avg:.2f}"
            elif s_stat["avg_percent"] is not None:
                pct = s_stat["avg_percent"]
                if pct >= 90.0:
                    subj_avg = 1.0
                elif pct >= 75.0:
                    subj_avg = 2.0
                elif pct >= 60.0:
                    subj_avg = 3.0
                elif pct >= 50.0:
                    subj_avg = 4.0
                else:
                    subj_avg = 5.0
                avg_display = f"{subj_avg:.2f}"
            else:
                avg_display = "-"

            if subj_avg is not None:
                subject_averages.append(subj_avg)
                final_mark = max(1, min(5, int(round(subj_avg))))
                final_str = str(final_mark)
                verbal_str = verbal_names[final_mark - 1]
            else:
                final_str = "-"
                verbal_str = "Nehodnotený"

            # Resolve full Slovak subject name from dbi
            sid = str(glist[0].subject_id) if glist and glist[0].subject_id is not None else ""
            s_row = dbi_subjects.get(sid, {})
            full_s_name = str(s_row.get("name") or s_name).strip()
            short_s_name = str(s_row.get("short") or s_name).strip()
            subj_teacher = next((g.teacher.name for g in glist if g.teacher and g.teacher.name), None) or teacher_by_short.get(short_s_name, "-")

            # Build per-subject distribution, chronological marks preview & detailed grade rows
            subj_dist = [0, 0, 0, 0, 0]
            chrono_subj = sorted(glist, key=lambda g: g.date if g.date else datetime.min)
            marks_preview = []
            for g in chrono_subj:
                marks_preview.append(format_grade_value(g))
                n_val = parse_slovak_grade(g)
                if n_val is not None and 1.0 <= n_val <= 5.0:
                    subj_dist[min(4, max(0, int(round(n_val)) - 1))] += 1

            subj_grade_rows = []
            for g in sorted(glist, key=lambda g: g.date if g.date else datetime.min, reverse=True):
                n_val = parse_slovak_grade(g)
                if g.max_points and g.grade_n is not None:
                    pts_str = f"{g.grade_n}/{g.max_points:g}"
                elif g.percent is not None:
                    pts_str = f"{g.percent:.1f}%"
                else:
                    pts_str = "-"

                pct_str = f"{g.percent:.1f}%" if g.percent is not None else "-"
                c_avg_str = str(g.class_grade_avg) if g.class_grade_avg else "-"
                tc_name = g.teacher.name if (g.teacher and g.teacher.name) else subj_teacher
                clean_details = [
                    str(x).strip()
                    for x in (g.more_details or [])
                    if str(x).strip() and not str(x).strip().startswith("{")
                ]
                note_txt = (str(g.comment).strip() if g.comment else "") or "; ".join(clean_details) or "-"

                subj_grade_rows.append({
                    "date": g.date.strftime("%Y-%m-%d") if g.date else "-",
                    "grade": format_grade_value(g),
                    "numeric_val": f"{n_val:.1f}" if n_val is not None else "-",
                    "points_str": pts_str,
                    "percent_str": pct_str,
                    "weight": format_weight(g),
                    "class_avg": c_avg_str,
                    "title": (g.title or "-").strip(),
                    "teacher": tc_name,
                    "note": note_txt,
                })

            pct_display = f"{s_stat['avg_percent']:.1f}%" if s_stat["avg_percent"] is not None else "-"
            data["subjects"].append({
                "name": s_name,
                "short": short_s_name,
                "full_name": full_s_name,
                "teacher": subj_teacher,
                "count": len(glist),
                "avg": avg_display,
                "percent": pct_display,
                "final_grade": final_str,
                "verbal": verbal_str,
                "marks_preview": marks_preview,
                "distribution": subj_dist,
                "grades": subj_grade_rows,
            })

        # Slovak GPA calculation: arithmetic mean of subject averages
        if subject_averages:
            overall_gpa = round(sum(subject_averages) / len(subject_averages), 2)
            data["gpa"] = f"{overall_gpa:.2f}"

            has_five = any(avg >= 4.5 for avg in subject_averages)
            has_four = any(avg >= 3.5 for avg in subject_averages)
            has_three = any(avg >= 2.5 for avg in subject_averages)

            if has_five:
                data["standing"] = "Neprospel"
            elif overall_gpa <= 1.50 and not has_three:
                data["standing"] = "Prospel s vyznamenaním"
            elif overall_gpa <= 2.00 and not has_four:
                data["standing"] = "Prospel veľmi dobre"
            else:
                data["standing"] = "Prospel"
        else:
            data["standing"] = "Nehodnotený"

        for g in sorted(grades, key=lambda g: g.date if g.date else datetime.min, reverse=True):
            clean_details = [
                str(x).strip()
                for x in (g.more_details or [])
                if str(x).strip() and not str(x).strip().startswith("{")
            ]
            s_sh = g.subject_name or "Unknown"
            tc_g = (g.teacher.name if (g.teacher and g.teacher.name) else None) or teacher_by_short.get(s_sh, "-")
            data["all_grades"].append({
                "date": g.date.strftime("%Y-%m-%d") if g.date else "-",
                "subject": s_sh,
                "grade": format_grade_value(g),
                "weight": format_weight(g),
                "title": g.title or "-",
                "teacher": tc_g,
                "note": (str(g.comment).strip() if g.comment else "") or "; ".join(clean_details),
                "comment": format_comment_and_teacher(g),
            })
    except Exception:
        pass

    # 4. Meals / Lunches
    try:
        meals = edupage.get_meals(date.today())
        if meals and meals.lunch:
            l = meals.lunch
            menus_list = []
            if l.menus:
                for m in l.menus:
                    menus_list.append({
                        "number": m.number,
                        "name": m.name,
                        "allergens": m.allergens or "",
                        "weight": m.weight or "",
                        "selected": (l.ordered_meal == m.number),
                    })
            data["lunches"] = {
                "title": l.title,
                "ordered_meal": l.ordered_meal,
                "status": f"ORDERED: {l.ordered_meal}" if l.ordered_meal else "NOT ORDERED",
                "serving": f"{l.served_from.strftime('%H:%M')} - {l.served_to.strftime('%H:%M')}" if (l.served_from and l.served_to) else "-",
                "menus": menus_list,
            }
    except Exception:
        pass

    # 5. Homework & tasks
    try:
        events = edupage.get_notifications()
        hw_types = {
            EventType.HOMEWORK,
            EventType.BIG_EXAM,
            EventType.SHORT_EXAM,
            EventType.ORAL_EXAM,
            EventType.TESTING,
            EventType.PAPER,
        }
        for e in events:
            if e.event_type in hw_types and not e.is_done:
                d_str = e.event_time.strftime("%Y-%m-%d") if e.event_time else (e.timestamp.strftime("%Y-%m-%d") if e.timestamp else "-")
                auth = e.author.name if hasattr(e.author, "name") and isinstance(e.author.name, str) else str(e.author or "Teacher")
                t_label = (e.event_type.value if hasattr(e.event_type, "value") else str(e.event_type)).upper()
                data["tasks"].append({
                    "date": d_str,
                    "type": t_label,
                    "author": auth,
                    "text": (e.text or "").replace("\n", " ").strip(),
                })
    except Exception:
        pass

    return data


def interactive_dashboard(edupage: Edupage, use_color: bool = True) -> None:
    """Hlavná navigačná slučka interaktívneho btop-style dashboardu."""
    print(colorize("[...] Loading live EduPage data for home monitor...", COLOR_DIM, use_color))
    cached_data = fetch_dashboard_cache(edupage)

    while True:
        clear_screen()
        render_home_dashboard(edupage, cached_data, use_color=use_color)

        prompt_str = colorize("edupage:~$ ", COLOR_BOLD, use_color)
        choice = input(prompt_str).strip().lower()

        if choice in ["0", "q", "exit", "quit"]:
            print(colorize("\n[OK] Logging out. Session ended.", COLOR_DIM, use_color))
            try:
                edupage.logout()
            except Exception:
                pass
            break

        elif choice in ["r", "refresh", "reload"]:
            print(colorize("[...] Refreshing live monitors...", COLOR_DIM, use_color))
            cached_data = fetch_dashboard_cache(edupage)

        elif choice in ["1", "grades", "znamky"]:
            clear_screen()
            view_grades(edupage, use_color=use_color)
            input("\n[press Enter to return to monitor]")

        elif choice in ["2", "timetable", "rozvrh"]:
            clear_screen()
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

            input("\n[press Enter to return to monitor]")

        elif choice in ["3", "substitution", "suplovanie"]:
            clear_screen()
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

            input("\n[press Enter to return to monitor]")

        elif choice in ["4", "lunches", "obedy"]:
            clear_screen()
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
            input("\n[press Enter to return to monitor]")

        elif choice in ["5", "homework", "ulohy", "tasks"]:
            clear_screen()
            print(colorize("\nTIMELINE FILTER:", COLOR_BOLD, use_color))
            print("  [1] Homework & exams only")
            print("  [2] All announcements and events")
            sub_ch = input("\n  select [1-2, default=1]: ").strip()
            hw_only = (sub_ch != "2")
            view_timeline_and_homework(edupage, homework_only=hw_only, use_color=use_color)
            input("\n[press Enter to return to monitor]")

        elif choice in ["6", "ringing", "zvonenie"]:
            clear_screen()
            view_ringing_times(edupage, use_color=use_color)
            input("\n[press Enter to return to monitor]")

        elif choice in ["7", "staff", "teachers", "ucitelia"]:
            clear_screen()
            q = input("Search staff by name (Enter for all): ").strip()
            view_teachers_directory(edupage, query=q if q else None, use_color=use_color)
            input("\n[press Enter to return to monitor]")

        elif choice in ["8", "config", "nastavenia"]:
            clear_screen()
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

            input("\n[press Enter to return to monitor]")


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
        help="School subdomain (defaults to 'ssnd').",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output.",
    )

    subparsers = parser.add_subparsers(dest="command", help="Direct non-interactive subcommands:")

    # Command: grades
    p_grades = subparsers.add_parser("grades", help="Show full screen grades overview.")
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

    # Command: dump-json
    subparsers.add_parser("dump-json", help="Export aggregated data as JSON.")

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
        if args.command == "dump-json":
            json_data = export_dashboard_json(edupage)
            print(json.dumps(json_data, ensure_ascii=False))
            sys.exit(0)
        elif args.command == "grades":
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
