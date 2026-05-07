# Prompt Log

---

**[2026-05-03 — prompt 1]**

create me a hook that saves every prompt i send to you to an md file

---

so, we are moving this project to claude code. As a first step i want to create a few md files and a claude.md. lets start with adding what kind of
  project this is (i.e. purpose, stack) to claude.md, and then also create a code index that walks through all the variatious functions, understands and
  indexes their purpose, so that future contexts can understand the codebase without rereading it all (token saving)


**[2026-05-03 — prompt 2]**

okay, for some more context, this is a hobby project, security is not a concern, for now it is a single-device local storage kind. despite what your claude.md file says, this project is hosted on git websites and it is not a requirement to store everything in the index file (update your md). Your task now is to act as a code detective, dive into the codebase, and figure out where it can break. What logical errors can occur during real usage. What gaps are there? I know there are at least 3 critcal bugs in the codebase however I don't have descriptions for them yet so you need to hunt them down through code understanding first

---

**[2026-05-03 — prompt 3]**

> okay log these into a bugs to fix file. Next, i just received a report that sometimes, halfway through a tournament, after some action is performed i.e.
  match made,player swapped, etc. that one of the entire court components can disappear from the screen, what might cause that?

---

**[2026-05-03 11:31:43]**

would you suggest implementing unit testing to this project>?


---

**[2026-05-03 11:31:51]**

> we'll need some way to verify the app works in a production setting and be able to try going through an entire 3 hour event step by step, what would you
  suggest instead

****
 yes please first fix all the listed bugs and then build that simulation script

****
 write and index all learnings from this session in an insights.md, mention key things in the claude.md file too and tell claude/md to read insights each
  session, uodate claude.md to say that it is not longer a single index file but one that is synced via firebase. also lets ensure the simulation has
  speed controls and also that it is synced live so i can watch the simulation run on one device and the update brackets on the other device. also is it
  possible for you to verify fixes via the simulator or only me? if you can too then each time we update the code we should have you run it through and
  see if it works