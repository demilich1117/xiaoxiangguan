import unittest

from extract_pdf import best_ocr_text, missing_ocr_models
from pathlib import Path
from tempfile import TemporaryDirectory


class OcrSelectionTests(unittest.TestCase):
    def test_missing_models_are_reported_for_selected_language_only(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "tessdata").mkdir()
            (root / "tessdata" / "eng.traineddata").write_bytes(b"fixture")
            self.assertEqual(missing_ocr_models(root / "tesseract.exe", "fra"), ["fra.traineddata"])
            self.assertEqual(missing_ocr_models(root / "tesseract.exe", "eng"), [])
            self.assertEqual(missing_ocr_models(root / "tesseract.exe", "jpn+eng"), ["jpn.traineddata"])
            external = root / "external-models"
            external.mkdir()
            (external / "jpn.traineddata").write_bytes(b"fixture")
            self.assertEqual(missing_ocr_models(root / "tesseract.exe", "jpn", external), [])
    def test_prefers_vertical_reading_order_over_garbled_rows(self):
        horizontal = "旅 あ 彼 rT 第\n人 る は 京 —\nは H ray 都 章\neR 橋 aA の 春"
        vertical = "第 一 章 春 の 京都\n昔 京 都 の 町 に 一 人 の 若者 が 住ん で いま し た 。\n彼 は 毎朝 古い 橋 を 渡っ て 学校 へ 通い まし た 。"
        self.assertEqual(best_ocr_text([(horizontal, False), (vertical, True)]),
                         "第一章春の京都\n昔京都の町に一人の若者が住んでいました。\n彼は毎朝古い橋を渡って学校へ通いました。")

    def test_keeps_horizontal_text_when_vertical_output_is_scrambled(self):
        horizontal = "第一章　春の京都\n昔、京都の町に一人の若者が住んでいました。\n彼は毎朝、古い橋を渡って学校へ通いました。"
        vertical = "た た た\n[「。 2 。\nま ま ae 上\nいい U い U . だ し\nで 通 し ま\nん へ ま り"
        self.assertEqual(best_ocr_text([(horizontal, False), (vertical, True)]), horizontal)


if __name__ == "__main__":
    unittest.main()
