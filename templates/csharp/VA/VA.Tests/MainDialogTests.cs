﻿// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Bot.Schema;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using $safeprojectname$.Utterances;

namespace $safeprojectname$
{
    [TestClass]
    [TestCategory("UnitTests")]
    public class MainDialogTests : BotTestBase
    {
        [TestMethod]
        public async Task Test_Intro_Message()
        {
            await GetTestFlow()
                .Send(new Activity()
                {
                    Type = ActivityTypes.ConversationUpdate,
                    MembersAdded = new List<ChannelAccount>() { new ChannelAccount("user") }
                })
                .AssertReply(activity => Assert.AreEqual(1, activity.AsMessageActivity().Attachments.Count))
                .StartTestAsync();
        }

        [TestMethod]
        public async Task Test_Help_Intent()
        {
            var allFirstPromptVariations = AllResponsesTemplates.ExpandTemplate("FirstPromptMessage");

            await GetTestFlow()
                .Send(string.Empty)
                .AssertReplyOneOf(allFirstPromptVariations.ToArray())
                .Send(GeneralUtterances.Help)
                .AssertReply(activity => Assert.AreEqual(1, activity.AsMessageActivity().Attachments.Count))
                .StartTestAsync();
        }

        [TestMethod]
        public async Task Test_Escalate_Intent()
        {
            var allFirstPromptVariations = AllResponsesTemplates.ExpandTemplate("FirstPromptMessage");

            await GetTestFlow()
                .Send(string.Empty)
                .AssertReplyOneOf(allFirstPromptVariations.ToArray())
                .Send(GeneralUtterances.Escalate)
                .AssertReply(activity => Assert.AreEqual(1, activity.AsMessageActivity().Attachments.Count))
                .StartTestAsync();
        }

        [TestMethod]
        [Ignore("the LG template 'UnsupportedMessage' has randomly generated response which makes this test unreliable")]
        public async Task Test_Unhandled_Message()
        {
            var allFirstPromptVariations = AllResponsesTemplates.ExpandTemplate("FirstPromptMessage");
            var allResponseVariations = AllResponsesTemplates.ExpandTemplate("UnsupportedMessage", TestUserProfileState);

            await GetTestFlow()
                .Send(string.Empty)
                .AssertReplyOneOf(allFirstPromptVariations.ToArray())
                .Send("Unhandled message")
                .AssertReplyOneOf(allResponseVariations.ToArray())
                .StartTestAsync();
        }
    }
}