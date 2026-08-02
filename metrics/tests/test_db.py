from unittest.mock import MagicMock

from metrics import db


def test_delete_insight_model_is_scoped_by_name():
    sb = MagicMock()
    table = sb.table.return_value

    db.delete_insight_model(sb, "ef_on_sleep_dlm")

    sb.table.assert_called_once_with("insight_models")
    table.delete.assert_called_once_with()
    table.delete.return_value.eq.assert_called_once_with("name", "ef_on_sleep_dlm")
    table.delete.return_value.eq.return_value.execute.assert_called_once_with()
