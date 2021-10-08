// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract TestWhitelist is OwnableUpgradeable {
    mapping(address => bool) internal _whitelist;

    event WhitelistEvent(address indexed addr, bool isInWhitelist);

    modifier whitelistCheck(address sender, address recipient) {
        if (!_whitelist[sender]) {
            require(_whitelist[recipient], "The address of recipient is not in whitelist.");
        }
        _;
    }

    function addToWhitelist(address addr) external onlyOwner {
        _whitelist[addr] = true;
        emit WhitelistEvent(addr, _whitelist[addr]);
    }

    function removeFromWhitelist(address addr) external onlyOwner {
        _whitelist[addr] = false;
        emit WhitelistEvent(addr, _whitelist[addr]);
    }

    function isInWhitelist(address addr) external view returns (bool) {
        return _whitelist[addr];
    }
}
