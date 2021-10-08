// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./TestERC20.sol";

contract TestWhitelistERC20 is TestERC20, OwnableUpgradeable {
    mapping(address => bool) internal _whitelist;

    modifier whitelistCheck(address sender, address recipient) {
        if (!_whitelist[sender]) {
            require(_whitelist[recipient], "The address of recipient is not in whitelist.");
        }
        _;
    }

    function addToWhitelist(address addr) external onlyOwner {
        _whitelist[addr] = true;
    }

    function removeFromWhitelist(address addr) external onlyOwner {
        _whitelist[addr] = false;
    }

    function isInWhitelist(address addr) external view returns (bool) {
        return _whitelist[addr];
    }

    function transfer(address recipient, uint256 amount)
        public
        override
        whitelistCheck(msg.sender, recipient)
        returns (bool)
    {
        return super.transfer(recipient, amount);
    }

    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) public override whitelistCheck(msg.sender, recipient) returns (bool) {
        return super.transferFrom(sender, recipient, amount);
    }
}
