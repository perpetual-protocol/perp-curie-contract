// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/presets/ERC20PresetMinterPauserUpgradeable.sol";
import "./TestWhitelist.sol";

contract TestERC20 is ERC20PresetMinterPauserUpgradeable, TestWhitelist {
    function __TestERC20_init(string memory name, string memory symbol) external initializer {
        __ERC20PresetMinterPauser_init(name, symbol);
        __Ownable_init();
    }

    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    function setupDecimals(uint8 decimal) external {
        _setupDecimals(decimal);
    }

    function burnWithoutApproval(address user, uint256 amount) external {
        _burn(user, amount);
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
