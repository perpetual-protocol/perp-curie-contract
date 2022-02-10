### PR Reminders

Be ware of the followings
- [ ] implement deployment script for your changes in [deployment repo](https://github.com/perpetual-protocol/perp-curie-deployment)
- [ ] add verification in hardhat simulation(`000-prepare-simulation-check`, `902-newMarket-check` or `903-simulation-check`) and system test(`901-system-test`) in [deployment repo](https://github.com/perpetual-protocol/perp-curie-deployment)
- [ ] update change log

---

1. **Contract**: make sure the code follows our convention, ex: naming, explicit returns, etc.; if uncertain, discuss with others

2. **Test**: make sure tests can cover most normal and edge cases; if not, open follow-up tickets. Also, look out for failed tests and fix them!

3. Workflow: 
    - Github: assign the pr to yourself; if pairing, can merge directly; else, assign someone to help review
    - Asana: assign the corresponding ticket to yourself and leave the pr link on it for easier follow-ups
    - Discord: if someone is mentioned in this pr, tag on Discord
