// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

abstract contract LowLevelErrorMessage {
    // __gap is reserved storage
    uint256[50] private __gap;

    function _getRevertMessage(bytes memory reason) internal pure returns (string memory) {
        if (reason.length < 68) return ("Unexpected error");
        assembly {
            reason := add(reason, 0x04)
        }
        return (abi.decode(reason, (string)));
    }
}
