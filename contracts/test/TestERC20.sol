// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/presets/ERC20PresetMinterPauserUpgradeable.sol";

contract TestERC20 is ERC20PresetMinterPauserUpgradeable {
    uint256 _transferFeeRatio;

    function __TestERC20_init(
        string memory name,
        string memory symbol,
        uint8 decimal
    ) public initializer {
        __ERC20PresetMinterPauser_init(name, symbol);
        _setupDecimals(decimal);
        _transferFeeRatio = 0;
    }

    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    function burnWithoutApproval(address user, uint256 amount) external {
        _burn(user, amount);
    }

    function setTransferFeeRatio(uint256 ratio) external {
        _transferFeeRatio = ratio;
    }

    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) public virtual override returns (bool success) {
        if (_transferFeeRatio != 0) {
            uint256 fee = (amount * _transferFeeRatio) / 100;
            _burn(sender, fee);
            amount = amount - fee;
        }
        return super.transferFrom(sender, recipient, amount);
    }
}
