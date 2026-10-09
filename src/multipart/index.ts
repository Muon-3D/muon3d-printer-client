// SPDX-License-Identifier: Apache-2.0
// The upload: the body every client sends (buildUploadBody), the gateway's rules it is checked against
// (checkUpload, checkPrintUpload), and the safe-name rule (isSafeName). vectors/upload.json holds request cases
// with the verdict each check must give, for any implementation of either side. Only these are the package's API;
// the modules' other exports are for its tests.
export { isSafeName, MAX_NAME_BYTES, unsafeNameReason } from './names.ts';
export { buildUploadBody, CHECKSUM_RE, UPLOAD_ROOT, type UploadBody, type UploadFile } from './build.ts';
export { checkPrintUpload, checkUpload, type UploadFields, type UploadRequest, type UploadVerdict } from './check.ts';
