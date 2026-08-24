/* Porównanie surowej transkrypcji z przesianą.
   Nie chodzi o techniczny diff, tylko o jedno pytanie:
   co sito zabrało, a co zostawiło. */

(function () {
  const normalize = (word) =>
    word
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");

  function tokenize(text) {
    return (text || "").split(/(\s+)/).filter((token) => token.length);
  }

  /**
   * @returns {Array<{type: "kept"|"gone"|"added", text: string}>}
   */
  function diffWords(raw, sifted) {
    const a = tokenize(raw);
    const b = tokenize(sifted);
    const aKeys = a.map(normalize);
    const bKeys = b.map(normalize);

    // LCS na słowach. Przy długości dyktowania (setki słów) to jest darmowe.
    const n = a.length;
    const m = b.length;
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] =
          aKeys[i] === bKeys[j] && aKeys[i] !== ""
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    const out = [];
    const push = (type, text) => {
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if ((aKeys[i] === bKeys[j] && aKeys[i] !== "") || (aKeys[i] === "" && bKeys[j] === "")) {
        push("kept", b[j]);
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        push("gone", a[i]);
        i++;
      } else {
        push("added", b[j]);
        j++;
      }
    }
    while (i < n) push("gone", a[i++]);
    while (j < m) push("added", b[j++]);

    // Same odstępy niech nie krzyczą kolorem.
    return out.map((part) => (part.text.trim() === "" ? { type: "kept", text: part.text } : part));
  }

  window.diffWords = diffWords;
})();
