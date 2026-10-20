// Fixed reference vocabulary. No data/storage/UI imports; shared wire validation.
export const REFERENCE_KINDS = ["Account","Category","Goal","Entry","Bill","Debt","Policy","Holding","Platform","Asset","Insurer","Budget","Contribution","Repayment","Trade","Flow","Valuation","Snapshot","Reconciliation"];
export const REFERENCE_PATTERN = `\\[(${REFERENCE_KINDS.join("|")}) [A-Z]{7} [A-Z]+\\]`;
export const REFERENCE_EXACT = new RegExp(`^${REFERENCE_PATTERN}$`);
export const referenceTokens = () => new RegExp(REFERENCE_PATTERN,"g");
export const PRIVATE_REFERENCE_FIELDS = {"policies@insurer":"Insurer","holdings@account_label":"Platform"};
