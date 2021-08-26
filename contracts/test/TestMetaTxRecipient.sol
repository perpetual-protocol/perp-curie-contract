// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { BaseRelayRecipient } from "../gsn/BaseRelayRecipient.sol";

contract TestMetaTxRecipient is BaseRelayRecipient {
    string public override versionRecipient = "1.0.0"; // we are not using it atm

    address public pokedBy;

    constructor(address _trustedForwarder) public {
        trustedForwarder = _trustedForwarder;
    }

    function poke() external {
        pokedBy = _msgSender();
    }

    // solhint-disable
    function error() external {
        revert("MetaTxRecipientMock: Error");
    }
}
