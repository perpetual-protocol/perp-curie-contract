// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";
import { BaseRelayRecipient, IRelayRecipient } from "../gsn/BaseRelayRecipient.sol";

contract TestMetaTxRecipient is BaseRelayRecipient, Initializable {
    address public pokedBy;

    function __TestMetaTxRecipient_init(address trustedForwarderArg) external initializer {
        _setTrustedForwarder(trustedForwarderArg);
    }

    function poke() external {
        pokedBy = _msgSender();
    }

    // solhint-disable
    function error() external pure {
        revert("MetaTxRecipientMock: Error");
    }

    /// @inheritdoc IRelayRecipient
    function versionRecipient() external pure override returns (string memory) {
        return "2.0.0";
    }
}
