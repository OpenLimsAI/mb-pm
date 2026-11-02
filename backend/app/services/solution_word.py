"""Editable Word export of report Markdown, with embedded images and no network I/O."""

import base64
import binascii
import io
import re
import struct
import zipfile
from urllib.parse import urlsplit
from xml.sax.saxutils import escape, quoteattr

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def clean(value):
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value))


class Word:
    def __init__(self):
        self.files = {}
        self.links = []
        self.image_id = 0

    def run(self, text, properties=""):
        props = f"<w:rPr>{properties}</w:rPr>" if properties else ""
        return f'<w:r>{props}<w:t xml:space="preserve">{escape(clean(text))}</w:t></w:r>'

    def image(self, alt, url):
        match = re.fullmatch(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)", url)
        if not match:
            return self.run(f"[图片：{alt or '未命名'}]（请在应用中查看）")
        try:
            data = base64.b64decode(match[2], validate=True)
        except (ValueError, binascii.Error):
            return self.run(f"[图片：{alt}]")
        if len(data) > 1024 * 1024:
            return self.run(f"[图片：{alt}]")
        if match[1] == "png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
            return self.run(f"[图片：{alt}]")
        if match[1] == "jpeg" and not data.startswith(b"\xff\xd8\xff"):
            return self.run(f"[图片：{alt}]")
        width, height = 640, 360
        if match[1] == "png" and len(data) >= 24:
            width, height = struct.unpack(">II", data[16:24])
        elif match[1] == "jpeg":
            pos = 2
            while pos + 8 < len(data):
                if data[pos] != 255:
                    break
                marker = data[pos + 1]
                size = int.from_bytes(data[pos + 2 : pos + 4], "big")
                if marker in (0xC0, 0xC1, 0xC2):
                    height = int.from_bytes(data[pos + 5 : pos + 7], "big")
                    width = int.from_bytes(data[pos + 7 : pos + 9], "big")
                    break
                if size < 2:
                    break
                pos += size + 2
        width, height = max(1, width), max(1, height)
        scale = min(1, 600 / width, 750 / height)
        cx, cy = int(width * scale * 9525), int(height * scale * 9525)
        self.image_id += 1
        ident = f"image{self.image_id}"
        filename = f"media/{ident}.{match[1]}"
        self.files[f"word/{filename}"] = data
        self.links.append(f'<Relationship Id="{ident}" Type="{R}/image" Target="{filename}"/>')
        return f"""<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{self.image_id}" name={quoteattr(clean(alt or ident))}/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="{self.image_id}" name={quoteattr(ident)}/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{ident}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"""

    def inline(self, text, properties="", depth=0):
        if depth > 8:
            return self.run(text, properties)
        pattern = r"(!?\[[^\]\n]*\]\([^\s)]+(?:\s+\"[^\"]*\")?\)|\*\*[^\n]+?\*\*|__[^\n]+?__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)"
        out = []
        for part in re.split(pattern, text):
            image = re.fullmatch(r"!\[([^\]]*)\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)", part)
            link = re.fullmatch(r"\[([^\]]*)\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)", part)
            if image:
                out.append(self.image(image[1], image[2]))
            elif link:
                try:
                    parsed = urlsplit(link[2])
                    valid = (
                        parsed.scheme in ("http", "https")
                        and parsed.hostname
                        and not parsed.username
                        and not parsed.password
                    )
                except ValueError:
                    valid = False
                if valid:
                    ident = f"link{len(self.links) + 1}"
                    self.links.append(
                        f'<Relationship Id="{ident}" Type="{R}/hyperlink" Target={quoteattr(clean(link[2]))} TargetMode="External"/>'
                    )
                    content = self.run(
                        link[1], properties + '<w:color w:val="0563C1"/><w:u w:val="single"/>'
                    )
                    out.append(f'<w:hyperlink r:id="{ident}">{content}</w:hyperlink>')
                else:
                    out.append(self.run(link[1], properties))
            elif part.startswith(("**", "__")) and len(part) > 4:
                out.append(self.inline(part[2:-2], properties + "<w:b/>", depth + 1))
            elif part.startswith(("*", "_")) and len(part) > 2:
                out.append(self.inline(part[1:-1], properties + "<w:i/>", depth + 1))
            elif part.startswith("`") and len(part) > 2:
                out.append(
                    self.run(
                        part[1:-1], properties + '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'
                    )
                )
            else:
                out.append(self.run(part, properties))
        return "".join(out)

    def paragraph(self, text, style="", number=None):
        props = f'<w:pStyle w:val="{style}"/>' if style else ""
        if number:
            props += f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{number}"/></w:numPr>'
        return f"<w:p><w:pPr>{props}</w:pPr>{self.inline(text)}</w:p>"

    def markdown(self, text):
        lines = clean(text).splitlines()
        result = []
        i = 0
        code = False
        while i < len(lines):
            line = lines[i]
            if line.lstrip().startswith(("```", "~~~")):
                code = not code
                i += 1
                continue
            if code:
                result.append(
                    '<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>' + self.run(line) + "</w:p>"
                )
            elif (
                i + 1 < len(lines)
                and "|" in line
                and re.fullmatch(r"\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*", lines[i + 1])
            ):
                rows = [line]
                i += 2
                while i < len(lines) and "|" in lines[i] and lines[i].strip():
                    rows.append(lines[i])
                    i += 1
                result.append(
                    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
                )
                column_count = len(re.split(r"(?<!\\)\|", rows[0].strip().strip("|")))
                result.append(
                    "<w:tblGrid>"
                    + "".join(
                        '<w:gridCol w:w="' + str(9000 // column_count) + '"/>'
                        for _ in range(column_count)
                    )
                    + "</w:tblGrid>"
                )
                for n, row in enumerate(rows):
                    cells = re.split(r"(?<!\\)\|", row.strip().strip("|"))
                    cells = (cells + [""] * column_count)[:column_count]
                    result.append(
                        "<w:tr>"
                        + ("<w:trPr><w:tblHeader/></w:trPr>" if n == 0 else "")
                        + "".join(
                            "<w:tc>"
                            + self.paragraph(
                                c.strip().replace("\\|", "|"), "TableHeader" if n == 0 else ""
                            )
                            + "</w:tc>"
                            for c in cells
                        )
                        + "</w:tr>"
                    )
                result.append("</w:tbl><w:p/>")
                continue
            else:
                heading = re.match(r"^(#{1,6})\s+(.+)$", line)
                bullet = re.match(r"^\s*[-+*]\s+(.+)$", line)
                ordered = re.match(r"^\s*\d+[.)]\s+(.+)$", line)
                quote = re.match(r"^\s*>\s?(.*)$", line)
                if heading:
                    result.append(
                        self.paragraph(heading[2], f"Heading{min(len(heading[1]) + 1, 6)}")
                    )
                elif bullet or ordered:
                    result.append(self.paragraph((bullet or ordered)[1], number=1 if bullet else 2))
                elif quote:
                    result.append(self.paragraph(quote[1], "Quote"))
                else:
                    result.append(self.paragraph(line))
            i += 1
        return "".join(result)

    def build(self, row):
        body = self.paragraph(row.title, "Title") + self.paragraph(
            f"v{row.version} · {'已定稿' if row.status == 'final' else '草稿 / 非定稿'} · {row.owner_name}"
        )
        body += self.paragraph(f"项目：{row.project_name}　产品：{row.product_name}")
        body += (
            self.paragraph("目录", "Heading1")
            + "<w:p><w:fldSimple w:instr='TOC \\o \"1-6\" \\h \\z \\u'><w:r><w:t>在 Word 中更新目录以显示页码</w:t></w:r></w:fldSimple></w:p>"
        )
        parents = {s["id"]: s.get("parent_id") for s in row.sections}
        for section in row.sections:
            level, parent, seen = 1, section.get("parent_id"), {section["id"]}
            while parent in parents and parent not in seen:
                seen.add(parent)
                level += 1
                parent = parents[parent]
            body += self.paragraph(section["title"], f"Heading{min(level, 6)}") + self.markdown(
                section["content"]
            )
        if row.formula:
            body += self.paragraph("配方表", "Heading1")
            for item in row.formula:
                columns = [
                    ("物料", "material"),
                    ("用途", "purpose"),
                    ("规格", "specification"),
                    ("目标用量", "amount"),
                    ("单位", "unit"),
                    ("计量基准", "basis"),
                    ("范围", "range"),
                    ("选择理由", "rationale"),
                    ("验证状态", "verification"),
                ]
                body += '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="6500"/></w:tblGrid>'
                for label, key in columns:
                    value = item.get(key, "")
                    if key == "verification":
                        value = "已确认" if value == "confirmed" else "待验证"
                    body += (
                        "<w:tr><w:tc>"
                        + self.paragraph(label)
                        + "</w:tc><w:tc>"
                        + self.paragraph(value)
                        + "</w:tc></w:tr>"
                    )
                evidence = ", ".join(
                    str(n)
                    for n, ref in enumerate(row.references, 1)
                    if ref["id"] in item.get("evidence_ids", [])
                )
                body += (
                    "<w:tr><w:tc>"
                    + self.paragraph("关联引用")
                    + "</w:tc><w:tc>"
                    + self.paragraph(evidence)
                    + "</w:tc></w:tr></w:tbl><w:p/>"
                )
        body += self.paragraph("参考资料", "Heading1")
        for n, ref in enumerate(row.references, 1):
            body += self.paragraph(
                f"[{n}] {ref['title']} · 版本 {ref['source_version']} · {ref['locator']}",
                "Heading2",
            ) + self.paragraph(ref["excerpt"])
            body += self.paragraph(f"来源ID：{ref['source_id']}；章节：{ref['section_id']}")
        if row.review_notes:
            body += self.paragraph("评审结论", "Heading1") + self.paragraph(row.review_notes)
        body += '<w:sectPr><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
        self.files["word/document.xml"] = (
            f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>'
        )
        self.files["word/footer.xml"] = (
            f'<w:ftr xmlns:w="{W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr="PAGE"/></w:p></w:ftr>'
        )
        self.files["word/settings.xml"] = (
            f'<w:settings xmlns:w="{W}"><w:updateFields w:val="true"/></w:settings>'
        )
        self.files["word/styles.xml"] = styles()
        self.files["word/numbering.xml"] = (
            f'<w:numbering xmlns:w="{W}">'
            + "".join(
                f'<w:abstractNum w:abstractNumId="{i}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{label}"/><w:pPr><w:ind w:left="540" w:hanging="270"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="{i}"><w:abstractNumId w:val="{i}"/></w:num>'
                for i, fmt, label in [(1, "bullet", "•"), (2, "decimal", "%1.")]
            )
            + "</w:numbering>"
        )
        links = "".join(
            f'<Relationship Id="{name}" Type="{R}/{name}" Target="{name}.xml"/>'
            for name in ("styles", "numbering", "settings", "footer")
        )
        self.files["word/_rels/document.xml.rels"] = (
            f'<Relationships xmlns="{REL}">{links}{"".join(self.links)}</Relationships>'
        )
        self.files["_rels/.rels"] = (
            f'<Relationships xmlns="{REL}"><Relationship Id="doc" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>'
        )
        content = '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        for name, kind in [
            ("document", "document.main"),
            ("styles", "styles"),
            ("numbering", "numbering"),
            ("settings", "settings"),
            ("footer", "footer"),
        ]:
            content += f'<Override PartName="/word/{name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>'
        self.files["[Content_Types].xml"] = (
            f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{content}</Types>'
        )
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in self.files.items():
                archive.writestr(name, data.encode() if isinstance(data, str) else data)
        return output.getvalue()


def styles():
    data = '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>'
    for i in range(1, 7):
        data += f'<w:style w:type="paragraph" w:styleId="Heading{i}"><w:name w:val="heading {i}"/><w:pPr><w:keepNext/><w:outlineLvl w:val="{i - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{34 - i * 2}"/><w:color w:val="24476B"/></w:rPr></w:style>'
    data += '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="526B7A"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>'
    data += (
        "".join(
            f'<w:{side} w:val="single" w:sz="4" w:color="CCD9E3"/>'
            for side in ("top", "bottom", "left", "right", "insideH", "insideV")
        )
        + "</w:tblBorders></w:tblPr></w:style>"
    )
    return f'<w:styles xmlns:w="{W}">{data}</w:styles>'
