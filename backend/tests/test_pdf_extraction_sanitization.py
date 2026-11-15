"""Exercise real PDF extraction without a database, IAM, or model service."""

import hashlib
import io

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.services.information.extract import extract_pdf


def _pdf(content, *, null_glyph=False):
    writer = PdfWriter()
    page = writer.add_blank_page(600, 800)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    if null_glyph:
        # Math fonts can map a printable glyph to U+0000 via ToUnicode.
        cmap = DecodedStreamObject()
        cmap.set_data(
            b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap "
            b"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def "
            b"/CMapName /Adobe-Identity-UCS def /CMapType 2 def "
            b"1 begincodespacerange <00> <FF> endcodespacerange "
            b"1 beginbfchar <58> <0000> endbfchar "
            b"endcmap CMapName currentdict /CMap defineresource pop end end"
        )
        font[NameObject("/ToUnicode")] = writer._add_object(cmap)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 30 700 Td " + content + b" ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.mark.parametrize("null_glyph", [False, True], ids=["literal-null", "font-null"])
def test_pdf_nulls_are_removed_from_text_without_changing_original(tmp_path, null_glyph):
    marker = b"X" if null_glyph else b"\\000"
    original = _pdf(
        b"(Readable research evidence before and after a mathematical glyph is preserved. "
        b"This synthetic paper is long enough for the real extraction boundary. left"
        + marker
        + b"right) Tj",
        null_glyph=null_glyph,
    )
    # Prove this is a real parser regression fixture, not a mocked text return.
    parser_text = PdfReader(io.BytesIO(original)).pages[0].extract_text(extraction_mode="plain")
    assert "left\x00right" in parser_text
    path = tmp_path / "math.pdf"
    path.write_bytes(original)
    original_hash = hashlib.sha256(original).hexdigest()

    text = extract_pdf(path)

    assert "\x00" not in text
    assert "leftright" in text
    assert "Readable research evidence" in text
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original_hash


def test_pdf_extraction_preserves_tabs_line_breaks_and_visible_text(tmp_path):
    original = _pdf(
        b"(Readable research evidence with valid spacing preserved for the user: alpha\\011beta) "
        b"Tj 0 -20 Td (Second line carries additional readable text and punctuation.) Tj"
    )
    path = tmp_path / "whitespace.pdf"
    path.write_bytes(original)

    text = extract_pdf(path)

    assert "alpha\tbeta\nSecond line" in text
    assert "## 第 1 页" in text
    assert path.read_bytes() == original
