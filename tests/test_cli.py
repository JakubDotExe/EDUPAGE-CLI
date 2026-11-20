import io
import unittest
from datetime import datetime
from unittest.mock import MagicMock, patch

from cli import (
    calculate_subject_stats,
    format_comment_and_teacher,
    format_grade_value,
    format_weight,
    get_grade_color,
    render_grades_table,
)
from edupage_api.grades import EduGrade


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
        # numeric grades: 1 (weight 1.0) and 2- (weight 1.0, value 2.5) -> avg = 3.5 / 2.0 = 1.75
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


if __name__ == "__main__":
    unittest.main()
