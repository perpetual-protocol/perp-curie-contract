// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

abstract contract LowLevelErrorMessage {
    // __gap is reserved storage
    uint256[50] private __gap;

    // suggested solution from ABDK, https://ethereum.stackexchange.com/a/110428/4955
    function _getRevertMessage(bytes memory revertData) internal pure returns (string memory reason) {
        uint256 len = revertData.length;
        if (len < 68) return ("Unexpected error");
        uint256 contentLength;
        assembly {
            revertData := add(revertData, 4)
            contentLength := mload(revertData) // Save the content of the length slot
            mstore(revertData, sub(len, 4)) // Set proper length
        }
        reason = abi.decode(revertData, (string));
        assembly {
            mstore(revertData, contentLength) // Restore the content of the length slot
        }
    }
}
