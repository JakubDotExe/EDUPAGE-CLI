#!/usr/bin/env python3
"""EduPage CLI entrypoint."""

from edupage_api.cli import (
    calculate_subject_stats,
    clear_saved_credentials,
    format_comment_and_teacher,
    format_grade_value,
    format_weight,
    get_grade_color,
    load_saved_credentials,
    main,
    render_grades_table,
    save_credentials,
)

if __name__ == "__main__":
    main()
