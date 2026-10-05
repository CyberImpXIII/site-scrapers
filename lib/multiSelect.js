// One definition of "this dropdown takes SEVERAL options", shared by the forms
// probe (describe_application_form's `multiple` on each field) and fill_form
// (which accepts an array answer only for such a control). Two copies of this
// test would drift exactly where it matters: describe telling a caller to send a
// list that the fill then refuses, or the reverse.
//
// A native <select multiple> says so itself (`el.multiple`). A react-select
// style combobox (Greenhouse) does not mark its <input>; react-select marks the
// VALUE CONTAINER around it with a `--is-multi` modifier (classNamePrefix
// "select" gives `select__value-container--is-multi`), present before anything
// is chosen. Chosen options render as chips whose label element carries
// `multi-value__label`. Both are matched by substring so another prefix works.
//
// Measured only on the offline fixture (test/fixtures/ats ?multi=1), which
// mirrors react-select's documented class names: no live Greenhouse field
// needing several options has been seen yet (TODO.md).

const MULTI_CONTAINER_SELECTOR = '[class*="value-container--is-multi"]';
const MULTI_CHIP_SELECTOR = '[class*="multi-value__label"]';
// How far up from the <input> the container is looked for. react-select
// nests the input 2-3 levels inside it; 6 matches fillForm's value readback.
const MULTI_ANCESTOR_LEVELS = 6;

module.exports = { MULTI_CONTAINER_SELECTOR, MULTI_CHIP_SELECTOR, MULTI_ANCESTOR_LEVELS };
