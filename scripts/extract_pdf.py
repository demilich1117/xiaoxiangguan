#!/usr/bin/env python3
"""Extract page-aware text from a PDF into resumable chapter files."""
from __future__ import annotations
import argparse, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from pypdf import PdfReader

HEADING=re.compile(r"^(?:第[0-9０-９一二三四五六七八九十百千]+[章節部篇回]|[0-9０-９一二三四五六七八九十]+[、\.．]\s*|序章|序[　 ]|はじめに|おわりに|あとがき|参考文献|付録|(?:Chapter|Chapitre|Kapitel|Cap[ií]tulo)\s+(?:\d+|[IVXLCDM]+)\b)",re.I)
JAPANESE=re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")
LATIN=re.compile(r"[A-Za-z]")
def clean(text):
    text=text.replace("\x00",""); text=re.sub(r"[ \t]+"," ",text); text=re.sub(r"\n{3,}","\n\n",text)
    return text.strip()
def title_for(text,number):
    for line in text.splitlines():
        line=line.strip()
        if line and len(line)<=90 and HEADING.match(line): return line
    return f"第 {number}–{number} 页"
def best_ocr_text(candidates):
    def score(candidate):
        text,_=candidate
        lines=[line for line in text.splitlines() if line.strip()]
        japanese=sum(len(JAPANESE.findall(line)) for line in lines)
        short_lines=sum(1 for line in lines if len(JAPANESE.findall(line))<8)
        return japanese-2*len(LATIN.findall(text))-4*short_lines
    text,vertical=max(candidates,key=score)
    if vertical:
        text=re.sub(r"(?<=[\u3040-\u30ff\u3400-\u9fff]) +(?=[\u3040-\u30ff\u3400-\u9fff。、！？])","",text)
    return clean(text)
def missing_ocr_models(tesseract, language, tessdata_dir=None):
    binary=Path(shutil.which(str(tesseract)) or str(tesseract))
    prefix=os.environ.get("TESSDATA_PREFIX")
    locations=[Path(tessdata_dir)] if tessdata_dir else [path for path in (
        Path(prefix) if prefix else None, Path(prefix)/"tessdata" if prefix else None,
        binary.parent/"tessdata", Path("/usr/share/tesseract-ocr/5/tessdata"),
        Path("/usr/share/tesseract-ocr/4.00/tessdata"), Path("/usr/share/tessdata"),
        Path("/opt/homebrew/share/tessdata"), Path("/usr/local/share/tessdata")) if path]
    return min(([f"{model}.traineddata" for model in language.split("+") if not (location/f"{model}.traineddata").exists()] for location in locations),key=len)
def main():
    p=argparse.ArgumentParser(); p.add_argument("source"); p.add_argument("--output",required=True); p.add_argument("--pages-per-unit",type=int,default=8); p.add_argument("--pdftoppm"); p.add_argument("--tesseract"); p.add_argument("--tessdata-dir"); p.add_argument("--ocr-language",default="jpn+eng"); p.add_argument("--ocr-label",default="日语"); a=p.parse_args()
    source=Path(a.source).resolve(); output=Path(a.output).resolve()
    if output.exists(): p.error(f"输出目录已存在：{output}")
    output.mkdir(parents=True); chapters_dir=output/"chapters"; chapters_dir.mkdir()
    reader=PdfReader(str(source)); pages=[]; empty=[]
    for index,page in enumerate(reader.pages,start=1):
        text=clean(page.extract_text() or "")
        if len(text)<20: empty.append(index)
        pages.append(text)
    pdftoppm=a.pdftoppm or shutil.which("pdftoppm"); tesseract=a.tesseract or shutil.which("tesseract")
    if empty and not tesseract:
        p.exit(2,f"扫描页需要{a.ocr_label} OCR，但未找到 Tesseract。请安装对应语言包：{a.ocr_language}。\n")
    if empty:
        missing=missing_ocr_models(tesseract,a.ocr_language,a.tessdata_dir)
        if missing: p.exit(2,f"缺少{a.ocr_label} OCR 模型：{', '.join(missing)}；请检查 TESSDATA_PREFIX 或 Tesseract 的 tessdata 目录。\n")
        if not pdftoppm: p.exit(2,"扫描页需要 Poppler 的 pdftoppm 渲染工具。\n")
    if empty and pdftoppm and tesseract:
        with tempfile.TemporaryDirectory(prefix="pdf-ocr-",dir=output) as temp:
            for page_number in list(empty):
                prefix=Path(temp)/f"page-{page_number}"
                rendered=subprocess.run([pdftoppm,"-f",str(page_number),"-l",str(page_number),"-r","300","-singlefile","-png",str(source),str(prefix)],capture_output=True)
                image=Path(str(prefix)+".png")
                if rendered.returncode or not image.exists(): continue
                candidates=[]
                tessdata_args=["--tessdata-dir",a.tessdata_dir] if a.tessdata_dir else []
                ocr=subprocess.run([tesseract,str(image),"stdout",*tessdata_args,"-l",a.ocr_language,"--psm","6"],capture_output=True,text=True,encoding="utf-8",errors="replace")
                if ocr.returncode==0: candidates.append((clean(ocr.stdout),False))
                if a.ocr_language.startswith("jpn") and not missing_ocr_models(tesseract,"jpn_vert",a.tessdata_dir):
                    vertical_ocr=subprocess.run([tesseract,str(image),"stdout",*tessdata_args,"-l","jpn_vert","--psm","5"],capture_output=True,text=True,encoding="utf-8",errors="replace")
                    if vertical_ocr.returncode==0: candidates.append((clean(vertical_ocr.stdout),True))
                text=best_ocr_text(candidates) if candidates else ""
                if len(text)>=20: pages[page_number-1]=text
        empty=[index for index,text in enumerate(pages,start=1) if len(text)<20]
    if not any(len(text)>=20 for text in pages):
        p.exit(2,f"扫描版 PDF 的{a.ocr_label} OCR 未能识别出正文。请检查扫描清晰度或换用带文字层的 PDF。\n")
    records=[]; size=max(1,a.pages_per_unit)
    for start in range(0,len(pages),size):
        end=min(len(pages),start+size); body=[]
        for page_index in range(start,end): body.append(f"[[PDF_PAGE_{page_index+1}]]\n{pages[page_index] or '[本页未提取到文本，可能需要 OCR]'}")
        text="\n\n".join(body).strip()+"\n"; number=len(records)+1; filename=f"chapter-{number:04d}.txt"
        (chapters_dir/filename).write_text(text,encoding="utf-8")
        records.append({"chapter_number":number,"title":title_for(pages[start],start+1),"source_locator":f"PDF {start+1}–{end} 页","pdf_start":start+1,"pdf_end":end,"output_file":f"chapters/{filename}","character_count":len(text)})
    result={"schema_version":1,"source_file":str(source),"source_format":"pdf","page_count":len(pages),"ocr_language":a.ocr_language,"ocr_attempted":bool(pdftoppm and tesseract),"pages_needing_ocr":empty,"extracted_chapter_count":len(records),"chapters":records}
    (output/"manifest.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"output":str(output),"chapters":len(records),"pages_needing_ocr":empty},ensure_ascii=False))
if __name__=="__main__": main()
