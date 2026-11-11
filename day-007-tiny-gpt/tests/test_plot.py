import pytest

from plot import main, plot_losses, read_log

CSV = """model,step,train_loss,val_loss,tokens_per_sec
bigram,0,4.2,4.2,0
bigram,10,2.6,2.6,900
gpt,0,4.2,4.2,0
gpt,10,2.0,2.1,500
"""


def test_read_log(tmp_path):
    p = tmp_path / "l.csv"
    p.write_text(CSV)
    s = read_log(p)
    assert set(s) == {"bigram", "gpt"} and s["gpt"]["val"] == [4.2, 2.1]


def test_plot_writes_png(tmp_path):
    p = tmp_path / "l.csv"
    p.write_text(CSV)
    out = plot_losses(p, tmp_path / "docs" / "loss.png")
    assert out.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_plot_empty_log(tmp_path):
    p = tmp_path / "l.csv"
    p.write_text("model,step,train_loss,val_loss,tokens_per_sec\n")
    with pytest.raises(ValueError):
        plot_losses(p, tmp_path / "x.png")


def test_main(tmp_path, capsys):
    p = tmp_path / "l.csv"
    p.write_text(CSV)
    main([str(p), str(tmp_path / "o.png")])
    assert "wrote" in capsys.readouterr().out
