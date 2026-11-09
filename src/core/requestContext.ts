/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The VS Code request helpers live in the host now; every existing import site keeps working. */
export { describeRequest } from '../hosts/vscode/describeRequest';
export type { DescribedPart, RequestDescription } from '../hosts/vscode/describeRequest';
export { chatContextOf, chatIdOf, chatLabelOf, conversationIdOf, resolveCwd, sessionKey, systemGuidanceOf, workspaceFoldersOf } from '../hosts/vscode/identity';
