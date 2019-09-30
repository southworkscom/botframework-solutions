/**
 * Copyright(c) Microsoft Corporation.All rights reserved.
 * Licensed under the MIT License.
 */

import {
    Activity,
    ActivityTypes,
    BotTelemetryClient,
    SemanticAction,
    StatePropertyAccessor,
    TurnContext,
    UserStater} from 'botbuilder';
import { ComponentDialog, ConfirmPrompt, DialogContext, DialogInstance, DialogReason,
    DialogTurnResult,
    DialogTurnStatus,
    WaterfallDialog,
    WaterfallStep,
    WaterfallStepContext} from 'botbuilder-dialogs';
import { ActivityExtensions,
    isProviderTokenResponse,
    MultiProviderAuthDialog,
    RouterDialogTurnResult,
    RouterDialogTurnStatus,
    TokenEvents} from 'botbuilder-solutions';
import { IServiceClientCredentials } from './auth';
import { IAction, ISkillManifest, ISlot, SkillEvents } from './models';
import { skillConstants } from './skillConstants';
import { SkillContext } from './skillContext';
import { SkillDialogOption } from './SkillDialogOptions';
import { ISkillIntentRecognizer } from './SkillIntentRecognizer';
import { ISkillSwitchConfirmOption } from './SkillSwitchConfirmOption';
import { ISkillTransport, TokenRequestHandler } from './skillTransport';
import { SkillWebSocketTransport } from './websocket';

/**
 * The SkillDialog class provides the ability for a Bot to send/receive messages to a remote Skill (itself a Bot).
 * The dialog name is that of the underlying Skill it's wrapping.
 */
export class SkillDialog extends ComponentDialog {
    private readonly authDialog?: MultiProviderAuthDialog;
    private readonly serviceClientCredentials: IServiceClientCredentials;
    private readonly userState: UserState;

    private readonly skillManifest: ISkillManifest;
    private readonly skillTransport: ISkillTransport;

    private readonly queuedResponses: Partial<Activity>[];

    private skillIntentRecognizer?: ISkillIntentRecognizer;

    public constructor(
        skillManifest: ISkillManifest,
        serviceClientCredentials: IServiceClientCredentials,
        telemetryClient: BotTelemetryClient,
        userState: UserState,
        authDialog?: MultiProviderAuthDialog,
        skillIntentRecognizer?: ISkillIntentRecognizer,
        skillTransport?: ISkillTransport
    ) {
        super(skillManifest.id);
        if (skillManifest === undefined) { throw new Error('skillManifest has no value'); }
        if (serviceClientCredentials === undefined) { throw new Error('serviceClientCredentials has no value'); }
        this.skillManifest = skillManifest;
        this.userState = userState;
        this.skillTransport = skillTransport || new SkillWebSocketTransport(telemetryClient);
        this.skillIntentRecognizer = skillIntentRecognizer;
        this.serviceClientCredentials = serviceClientCredentials;

        const intentSwitching: WaterfallStep[] = [ this.confirmIntentSwitch, this.finishIntentSwitch ];

        this.queuedResponses = [];

        if (authDialog !== undefined) {
            this.authDialog = authDialog;
            this.addDialog(this.authDialog);
        }

        this.addDialog(new WaterfallDialog(DialogIds.confirmSkillSwitchFlow, intentSwitching));
        this.addDialog(new ConfirmPrompt(DialogIds.confirmSkillSwitchPrompt));
    }

    public async confirmIntentSwitch(stepContext: WaterfallStepContext): Promise<DialogTurnResult> {
        const confirmOptions: ISkillSwitchConfirmOption = <ISkillSwitchConfirmOption> stepContext.options;

        if (stepContext.options !== null && confirmOptions !== undefined) {
            const newIntentName: string = confirmOptions.targetIntent;
            const intentResponse: string = `Are you sure to switch to ${ newIntentName }?`;

            return stepContext.prompt(DialogIds.confirmSkillSwitchPrompt, { prompt: {
                    type: ActivityTypes.Message,
                    text: intentResponse,
                    speak: intentResponse
                }
            });
        }

        return stepContext.next();
    }

    public async finishIntentSwitch(stepContext: WaterfallStepContext): Promise<DialogTurnResult> {
        const confirmOptions: ISkillSwitchConfirmOption = <ISkillSwitchConfirmOption> stepContext.options;

        if (stepContext.options !== null && confirmOptions !== undefined) {
            // Do skill switching
            if (confirmOptions !== undefined) {
                // 1) End remote skill dialog
                await this.skillTransport.cancelRemoteDialogs(this.skillManifest, this.serviceClientCredentials, stepContext.context);

                // 2) Reset user input
                const activityText: string|undefined = confirmOptions.userInputActivity.text;
                stepContext.context.activity.text = activityText !== undefined ? activityText : '';
                stepContext.context.activity.speak  = confirmOptions.userInputActivity.speak;

                // 3) End dialog
                return stepContext.endDialog(true);
            } else {

                // Cancel skill switching
                const dialogResult: DialogTurnResult  = await this.forwardToSkill(stepContext, confirmOptions.userInputActivity);

                return stepContext.endDialog(dialogResult);
            }
        }

        // We should never go here
        return stepContext.endDialog();
    }
    public async endDialog(context: TurnContext, instance: DialogInstance, reason: DialogReason): Promise<void> {
        if (reason === DialogReason.cancelCalled) {
            // when dialog is being ended/cancelled, send an activity to skill
            // to cancel all dialogs on the skill side
            if (this.skillTransport !== undefined) {
                await this.skillTransport.cancelRemoteDialogs(this.skillManifest, this.serviceClientCredentials, context);
            }
        }

        await super.endDialog(context, instance, reason);
    }

    /**
     * When a SkillDialog is started, a skillBegin event is sent which firstly indicates the Skill is being invoked in Skill mode,
     * also slots are also provided where the information exists in the parent Bot.
     * @param innerDC inner dialog context.
     * @param options options
     * @returns dialog turn result.
     */
    // tslint:disable-next-line: max-func-body-length
    protected async onBeginDialog(innerDC: DialogContext, options?: object): Promise<DialogTurnResult> {
        let slots: SkillContext = new SkillContext();

        const accesor: StatePropertyAccessor = this.userState.createProperty<SkillContext>(SkillContext.name);
        const skillContext: SkillContext = await accesor.get(innerDC.context, () => new SkillContext());

        const dialogOptions: SkillDialogOption = options !== undefined ? <SkillDialogOption> options : { action: '' };
        const actionName: string = dialogOptions.action;

        const activity: Activity = innerDC.context.activity;

        // only set SemanticAction if it's not populated
        if (activity.semanticAction !== undefined) {
            const semanticAction: SemanticAction = { id: actionName, entities: {}, state : '' };

            if (actionName || actionName !== '') {
                // only set the semantic state if action is not empty
                semanticAction.state = skillConstants.skillStart;

                // Find the specified within the selected Skill for slot filling evaluation
                const action: IAction|undefined = this.skillManifest.actions.find((item: IAction): boolean => item.id === actionName);
                if (action !== undefined) {
                    // If the action doesn't define any Slots or SkillContext is empty then we skip slot evaluation
                    if (action.definition.slots !== undefined && action.definition.slots.length > 0) {
                        // Match Slots to Skill Context
                        slots = await this.matchSkillContextToSlots(innerDC, action.definition.slots, skillContext);
                    }
                } else {
                    const message: string = `Passed Action (${
                        actionName
                    }) could not be found within the ${
                        this.skillManifest.id
                    } skill manifest action definition.`;

                    throw new Error(message);
                }
            } else {
                // The caller hasn't got the capability of identifying the action as well as the Skill so we enumerate
                // actions and slot data to pass what we have

                // Retrieve a distinct list of all slots,
                // some actions may use the same slot so we use distinct to ensure we only get 1 instance.
                const skillSlots: ISlot[] = this.skillManifest.actions.reduce(
                    (acc: ISlot[], curr: IAction): ISlot[] => {
                        const currDistinct: ISlot[] = curr.definition.slots.filter(
                            (slot: ISlot): boolean => !acc.find((item: ISlot): boolean => item.name === slot.name)
                        );

                        return acc.concat(currDistinct);
                    },
                    []);

                if (skillSlots !== undefined) {
                // Match Slots to Skill Context
                slots = await this.matchSkillContextToSlots(innerDC, skillSlots, skillContext);
                }
            }

            slots.forEachObj((value: object, index: string) => semanticAction.entities.push);

            activity.semanticAction = semanticAction;
        }

        await innerDC.context.sendActivity({
            type: ActivityTypes.Trace,
            text: `-->Handing off to the ${this.skillManifest.name} skill.`
        });

        const dialogResult: DialogTurnResult = await this.forwardToSkill(innerDC, activity);
        this.skillTransport.disconnect();

        return dialogResult;
    }

    /**
     * All subsequent messages are forwarded on to the skill.
     * @param innerDC Inner Dialog Context.
     * @returns DialogTurnResult.
     */
    protected async onContinueDialog(innerDC: DialogContext): Promise<DialogTurnResult> {
        const activity: Activity = innerDC.context.activity;
        if (this.authDialog && innerDC.activeDialog && innerDC.activeDialog.id === this.authDialog.id) {
            // Handle magic code auth
            const result: DialogTurnResult<Object> = await innerDC.continueDialog();

            // forward the token response to the skill
            if (result.status === DialogTurnStatus.complete && isProviderTokenResponse(result.result)) {
                activity.type = ActivityTypes.Event;
                activity.name = TokenEvents.tokenResponseEventName;
                activity.value = result.result;
            } else {
                return result;
            }
        }

        const dialogId: string = innerDC.activeDialog ? innerDC.activeDialog.id : '';
        if (dialogId === DialogIds.confirmSkillSwitchPrompt) {
            const result: DialogTurnResult = await super.onContinueDialog(innerDC);

            if (result.status !== DialogTurnStatus.complete) {
                return result;
            } else {
                 // SkillDialog only truely end when confirm skill switch.
                if (result.result) {
                    // Restart and redispatch
                    result.result = new RouterDialogTurnResult(RouterDialogTurnStatus.Restart);
                } else {
                    result.status = DialogTurnStatus.waiting;
                }

                return result;
            }
        }

        const dialogResult: DialogTurnResult = await this.forwardToSkill(innerDC, activity);
        this.skillTransport.disconnect();

        return dialogResult;
    }

    public async matchSkillContextToSlots(innerDc: DialogContext, actionSlots: ISlot[], skillContext: SkillContext): Promise<SkillContext> {
        const slots: SkillContext = new SkillContext();

        if (actionSlots !== undefined && actionSlots.length > 0) {
            actionSlots.forEach(async (slot: ISlot): Promise<void> => {
                // For each slot we check to see if there is an exact match, if so we pass this slot across to the skill
                const value: Object|undefined = skillContext.getObj(slot.name);
                if (skillContext !== undefined && value !== undefined) {
                    slots.setObj(slot.name, value);

                    // Send trace to emulator
                    await innerDc.context.sendActivity({
                        type: ActivityTypes.Trace,
                        text: `-->Matched the ${ slot.name } slot within SkillContext and passing to the Skill.`
                    });
                }
            });
        }

        return slots;
    }

    /**
     * Forward an inbound activity on to the Skill.
     * This is a synchronous operation whereby all response activities are aggregated and returned in one batch.
     * @param innerDc Inner DialogContext.
     * @param activity Activity.
     * @returns DialogTurnResult.
     */
    private async forwardToSkill(innerDc: DialogContext, activity: Partial<Activity>): Promise<DialogTurnResult> {
        try {
            const handoffActivity: Partial<Activity> = await this.skillTransport.forwardToSkill(
                this.skillManifest,
                this.serviceClientCredentials,
                innerDc.context,
                activity,
                this.getTokenRequestCallback(innerDc));

            if (handoffActivity !== undefined) {
                await innerDc.context.sendActivity({
                    type: ActivityTypes.Trace,
                    text: `<--Ending the skill conversation with the ${ this.skillManifest.name } Skill and handing off to Parent Bot.`
                });

                return await innerDc.endDialog(handoffActivity.semanticAction ? handoffActivity.semanticAction.entities : undefined);
            } else {

                let dialogResult: DialogTurnResult = {
                    status: DialogTurnStatus.waiting
                };

                // if there's any response we need to send to the skill queued
                // forward to skill and start a new turn
                while (this.queuedResponses.length > 0) {

                    const lastEvent: Partial<Activity> | undefined = this.queuedResponses.pop();
                    if (lastEvent === SkillEvents.fallbackEventName) {
                        // Set fallback event to fallback handled event
                        lastEvent.name = SkillEvents.fallbackHandledEventName;

                        // if skillIntentRecognizer specified, run the recognizer
                        if (this.skillIntentRecognizer !== undefined
                            && this.skillIntentRecognizer.recognizeSkillIntentAsync !== undefined) {
                            const recognizedSkillManifest: string = await this.skillIntentRecognizer.recognizeSkillIntentAsync(innerDc);

                            // if the result is an actual intent other than the current skill, launch the confirm dialog (if configured)
                            // to eventually switch to a different skill.
                            // if the result is the same as the current intent, re-send it to the current skill
                            // if the result is empty which means no intent, re-send it to the current skill
                            if (recognizedSkillManifest !== undefined && recognizedSkillManifest !== this.id) {
                                if (this.skillIntentRecognizer.confirmIntentSwitch) {
                                    const options: ISkillSwitchConfirmOption = {
                                        fallbackHandledEvent: lastEvent,
                                        targetIntent: recognizedSkillManifest,
                                        userInputActivity: innerDc.context.activity
                                    }

                                    return await innerDc.beginDialog(DialogIds.confirmSkillSwitchFlow, options);
                                }

                                await this.skillTransport.cancelRemoteDialogs(
                                    this.skillManifest,
                                    this.serviceClientCredentials,
                                    innerDc.context
                                );

                                return await innerDc.endDialog(recognizedSkillManifest);
                            }
                        }
                    }

                    if (lastEvent !== undefined) {
                        dialogResult = await this.forwardToSkill(innerDc, lastEvent);
                    }
                }

                return dialogResult;
            }
        } catch (error) {
            // something went wrong forwarding to the skill, so end dialog cleanly and throw so the error is logged.
            // NOTE: errors within the skill itself are handled by the OnTurnError handler on the adapter.
            await innerDc.endDialog();
            throw error;
        }
    }

    private getTokenRequestCallback(dialogContext: DialogContext): TokenRequestHandler {
        return async (activity: Activity): Promise<void> => {
            // Send trace to emulator
            await dialogContext.context.sendActivity({
                type: ActivityTypes.Trace,
                text: '<--Received a Token Request from a skill'
            });

            const result: DialogTurnResult = await dialogContext.beginDialog(this.authDialog ? this.authDialog.id : '');

            if (result.status === DialogTurnStatus.complete) {
                const resultObj: any = result.result;

                if (resultObj !== undefined && isProviderTokenResponse(result)) {
                    const tokenEvent: Activity = ActivityExtensions.createReply(activity);
                    tokenEvent.type = ActivityTypes.Event;
                    tokenEvent.name = TokenEvents.tokenResponseEventName;
                    tokenEvent.value = resultObj;

                    this.queuedResponses.push(tokenEvent);
                } else {
                    this.authDialogCancelled = true;
                }
            }
        };
    }

    private getFallbackCallback(dialogContext: DialogContext): TokenRequestHandler {
        return async (activity: Activity): Promise<void> => {
            // Send trace to emulator
            await dialogContext.context.sendActivity({
                type: ActivityTypes.Trace,
                text: '<--Received a fallback request from a skill'
            });

            const fallbackEvent: Activity = ActivityExtensions.createReply(activity);
            fallbackEvent.type = ActivityTypes.Event;
            fallbackEvent.name = SkillEvents.fallbackEventName;

            this.queuedResponses.push(fallbackEvent);
        }
    }

}

export enum DialogIds {
    confirmSkillSwitchPrompt = 'confirmSkillSwitchPrompt',
    confirmSkillSwitchFlow = 'confirmSkillSwitchFlow'
}
