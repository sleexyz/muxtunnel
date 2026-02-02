The goal here is to beam claude code sessions running in tmux sessions to my phone.


Part of this is not running claude code in any weird configuration. I want my tmux sessions / claude code TUI sessions to be driveable from .

Basically I want to see the extent we can exploit the "analog hole" here -- there's going to be TUIs. can we build something that drives TUIs? Of course, lets just start with the claude code TUI for now -- no need to build something generically at first.


A first exploration is just seeing what we can read from the tmux sessions.
I'll probably have many tmux sessions, many claude code sessions.
A challenge will be identifying and surfacing the right sessions to the user -- ultimately a UX problem.
In any case, there's the questions of whether we can extract out any structured data.
- do we need to do any sort of normalization on top of the tmux output
- can we do so programmatically? do we need AI in the loop?


Let's build a bunch of debugging tools as part of this first exploration:
- a visualizer on all tmux sessions and all the data. highlight the claude code sessions.
  - a visualizer on all tmux sessions



A second exploration is then seeing what I can write to from tmux sessions.




Before we begin: I would love to see if there's any prior art / open source on driving TUI apps with agents / driving claude code directly / SDKs or what not for programmatically interfacing with tmux.


Let's do these in spikes.

Are there anythings worth clarifying before starting with our pre-spike research pass?
