import io
import os
import tempfile
import unittest
from datetime import date, datetime, time
from unittest.mock import MagicMock, patch

from cli import (
    calculate_subject_stats,
    clear_saved_credentials,
    format_comment_and_teacher,
    format_grade_value,
    format_weight,
    get_grade_color,
    load_saved_credentials,
    render_grades_table,
    save_credentials,
)
from edupage_api.cli import render_day_timetable, render_meal_card
from edupage_api.grades import EduGrade
from edupage_api.lunches import Meal, MealType, Menu
from edupage_api.timetables import Lesson, Timetable


class TestCli(unittest.TestCase):
    def setUp(self):
        mock_teacher = MagicMock()
        mock_teacher.name = "Mgr. Testovací"

        self.mock_grade_numeric = EduGrade(
            event_id=1,
            title="Písomka - lineárne rovnice",
            grade_n=1,
            comment="Výborná práca",
            date=datetime(2026, 11, 15, 8, 0),
            subject_id=10,
            subject_name="Matematika",
            teacher=mock_teacher,
            max_points=None,
            more_details=None,
            importance=1.0,
            verbal=False,
            percent=None,
            class_grade_avg=2.1,
        )

        self.mock_grade_percent = EduGrade(
            event_id=2,
            title="Polročný test",
            grade_n=18,
            comment=None,
            date=datetime(2026, 11, 10, 9, 0),
            subject_id=10,
            subject_name="Matematika",
            teacher=None,
            max_points=20,
            more_details=None,
            importance=2.0,
            verbal=False,
            percent=90.0,
            class_grade_avg=None,
        )

        self.mock_grade_minus = EduGrade(
            event_id=3,
            title="Skúšanie",
            grade_n="2-",
            comment=None,
            date=datetime(2026, 10, 5, 10, 0),
            subject_id=10,
            subject_name="Matematika",
            teacher=None,
            max_points=None,
            more_details=None,
            importance=1.0,
            verbal=False,
            percent=None,
            class_grade_avg=None,
        )

    def test_format_grade_value(self):
        self.assertEqual(format_grade_value(self.mock_grade_numeric), "1")
        self.assertEqual(format_grade_value(self.mock_grade_percent), "18/20 (90.0%)")

    def test_format_weight(self):
        self.assertEqual(format_weight(self.mock_grade_numeric), "1")
        self.assertEqual(format_weight(self.mock_grade_percent), "2")

    def test_format_comment_and_teacher(self):
        res = format_comment_and_teacher(self.mock_grade_numeric)
        self.assertIn("Výborná práca", res)
        self.assertIn("učiteľ: Mgr. Testovací", res)
        self.assertIn("priemer triedy: 2.10", res)

    def test_calculate_subject_stats(self):
        grades = [self.mock_grade_numeric, self.mock_grade_percent, self.mock_grade_minus]
        stats = calculate_subject_stats(grades)
        self.assertEqual(stats["count"], 3)
        self.assertEqual(stats["count_percent"], 1)
        self.assertEqual(stats["avg_percent"], 90.0)
        self.assertAlmostEqual(stats["avg_grade"], 1.75)

    def test_render_grades_table(self):
        output = io.StringIO()
        grades_by_subject = {"Matematika": [self.mock_grade_numeric, self.mock_grade_percent]}
        with patch("sys.stdout", output):
            render_grades_table(grades_by_subject, user_info="test_user", use_color=False)
        rendered = output.getvalue()
        self.assertIn("EDUPAGE CLI", rendered)
        self.assertIn("MATEMATIKA", rendered)
        self.assertIn("Písomka - lineárne rovnice", rendered)
        self.assertIn("Polročný test", rendered)

    def test_render_day_timetable(self):
        mock_subj = MagicMock()
        mock_subj.name = "Informatika"
        mock_room = MagicMock()
        mock_room.name = "UČ-1"
        mock_teacher = MagicMock()
        mock_teacher.name = "Ing. Byte"

        lesson = Lesson(
            period=1,
            start_time=time(8, 0),
            end_time=time(8, 45),
            duration=1,
            subject=mock_subj,
            classes=None,
            groups=None,
            teachers=[mock_teacher],
            classrooms=[mock_room],
            curriculum="Základy programovania v Pythone",
            online_lesson_link=None,
            is_cancelled=False,
            is_event=False,
        )

        tt = Timetable(lessons=[lesson])
        output = io.StringIO()
        with patch("sys.stdout", output):
            render_day_timetable(tt, target_date=date(2026, 11, 20), use_color=False)
        rendered = output.getvalue()
        self.assertIn("Informatika", rendered)
        self.assertIn("Ing. Byte", rendered)
        self.assertIn("UČ-1", rendered)

    def test_render_meal_card(self):
        menu1 = Menu(name="Slepačí vývar", allergens="1, 9", weight="250ml", number="1", rating=None)
        menu2 = Menu(name="Bravčový rezeň, zemiaky", allergens="1, 3", weight="120g", number="A", rating=None)
        meal = Meal(
            served_from=datetime(2026, 11, 20, 11, 30),
            served_to=datetime(2026, 11, 20, 13, 30),
            amount_of_foods=2,
            chooseable_menus=["A"],
            can_be_changed_until=datetime(2026, 11, 20, 8, 0),
            title="Obed",
            menus=[menu1, menu2],
            date=datetime(2026, 11, 20),
            ordered_meal="A",
            meal_type=MealType.LUNCH,
            _Meal__boarder_id="123",
            _Meal__meal_index="1",
        )
        output = io.StringIO()
        with patch("sys.stdout", output):
            render_meal_card(meal, "Obed", use_color=False)
        rendered = output.getvalue()
        self.assertIn("Bravčový rezeň", rendered)
        self.assertIn("Slepačí vývar", rendered)
        self.assertIn("[ORDERED: A]", rendered)

    def test_credentials_flow(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = os.path.join(tmpdir, "creds.json")
            with patch("edupage_api.cli.CONFIG_FILE", test_file), patch("edupage_api.cli.CONFIG_DIR", tmpdir):
                self.assertTrue(save_credentials("user1", "pass1", "ssnd"))
                u, p, s = load_saved_credentials()
                self.assertEqual(u, "user1")
                self.assertEqual(p, "pass1")
                self.assertEqual(s, "ssnd")
                self.assertTrue(clear_saved_credentials())
                u2, p2, s2 = load_saved_credentials()
                self.assertIsNone(u2)


if __name__ == "__main__":
    unittest.main()
