#!/usr/bin/env python3
"""EduPage CLI entrypoint."""

from edupage_api.cli import (
    calculate_subject_stats,
    format_comment_and_teacher,
    format_grade_value,
    format_weight,
    get_grade_color,
    main,
    render_grades_table,
)

if __name__ == "__main__":
    main()
